"""
Rescova Evi LiveKit agent worker.

Runs server-side. Holds the Deepslate credentials, joins authorized case-call
rooms, and bridges their audio to Deepslate Opal via the deepslate-livekit
plugin.

    phone ──(SIP)──▶ LiveKit room ◀── THIS AGENT ──(WSS)──▶ Deepslate

Setup:
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r agent/requirements.txt
    cp agent/.env.example agent/.env   # fill in keys
    python agent/agent.py dev          # dev mode (connects to LiveKit, waits for rooms)

Every accepted room must carry the server-generated case metadata and
short-lived call token. Rooms without it are rejected before a model session
is created.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Optional

from dotenv import load_dotenv

# Load agent/.env (sits next to this file).
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# Surface Deepslate-layer logs (e.g. "server error [ERROR_TTS]") in the agent
# terminal so we can diagnose the hosted-voice path.
logging.getLogger("deepslate").setLevel(logging.DEBUG)
logging.getLogger("deepslate.core").setLevel(logging.DEBUG)
if not logging.getLogger("deepslate").handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.getLogger("deepslate").addHandler(_h)
    logging.getLogger("deepslate").propagate = True

import aiohttp

from livekit import agents, rtc
from livekit.agents import (
    AgentServer,
    AgentSession,
    Agent,
    RunContext,
    function_tool,
    BackgroundAudioPlayer,
    AudioConfig,
    BuiltinAudioClip,
)

import deepslate.livekit.realtime
# TTS config classes live in the base SDK, not the livekit plugin module.
from deepslate.core import (
    HostedTtsConfig,
    HostedTtsMode,
)


def build_tts_config(hosted_voice_id: str):
    """Build the Evi voice pinned by trusted server-side room metadata."""
    print(f"[agent] using Evi hosted voice id: {hosted_voice_id}")
    return HostedTtsConfig(voice_id=hosted_voice_id, mode=HostedTtsMode.HIGH_QUALITY)


async def wait_for_outbound_sip_answer(
    ctx: agents.JobContext,
    timeout_seconds: float = 85.0,
) -> rtc.RemoteParticipant:
    """Wait until the outbound SIP leg is answered before starting Evi.

    LiveKit adds an outbound SIP participant while the phone is still dialing.
    Starting AgentSession at that point plays the greeting during ringback, so
    the callee hears silence after answering. `sip.callStatus=active` is the
    authoritative signal that the call has connected.
    """
    participant = await asyncio.wait_for(
        ctx.wait_for_participant(kind=rtc.ParticipantKind.PARTICIPANT_KIND_SIP),
        timeout=timeout_seconds,
    )
    deadline = asyncio.get_running_loop().time() + timeout_seconds

    while True:
        status = participant.attributes.get("sip.callStatus", "")
        if status == "active":
            print(f"[agent] SIP call answered: {participant.identity}")
            return participant
        if status == "hangup" or participant.identity not in ctx.room.remote_participants:
            raise RuntimeError("SIP participant disconnected before answer")
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("timed out waiting for SIP call to be answered")
        await asyncio.sleep(0.1)


# ── Diagnostics (enable with DEEPSLATE_DIAG=1) ──────────────────────────────
# The plugin does not log audio throughput or VAD events, so a silent-agent
# problem is indistinguishable from a deaf server. These patches log (a) a
# frame/byte counter for audio actually sent to Deepslate every ~5s and
# (b) every server VAD state transition.
if os.environ.get("DEEPSLATE_DIAG") == "1":
    import time as _time

    from deepslate.core.session import DeepslateSession as _DSSession
    from deepslate.livekit.realtime import _model as _ds_model

    _orig_send_audio = _DSSession.send_audio
    _diag_stats = {"frames": 0, "bytes": 0, "last_log": 0.0}

    async def _send_audio_diag(self, pcm_bytes, sample_rate, channels, *args, **kwargs):
        _diag_stats["frames"] += 1
        _diag_stats["bytes"] += len(pcm_bytes)
        now = _time.time()
        if now - _diag_stats["last_log"] > 5:
            _diag_stats["last_log"] = now
            print(
                f"[diag] audio->deepslate: {_diag_stats['frames']} frames, "
                f"{_diag_stats['bytes']} bytes total, sr={sample_rate}, ch={channels}"
            )
        return await _orig_send_audio(self, pcm_bytes, sample_rate, channels, *args, **kwargs)

    _DSSession.send_audio = _send_audio_diag

    _orig_vad_event = _ds_model.DeepslateRealtimeSession.on_vad_state_event

    async def _vad_diag(self, from_state, to_state, session_time_ms, packet_id):
        print(f"[diag] VAD {from_state} -> {to_state} @{session_time_ms}ms pkt={packet_id}")
        return await _orig_vad_event(self, from_state, to_state, session_time_ms, packet_id)

    _ds_model.DeepslateRealtimeSession.on_vad_state_event = _vad_diag


# ── Sustained-speech barge-in (BARGE_IN_MIN_MS) ─────────────────────────────
# The plugin interrupts the agent on the very first confirmed SPEECH. On PSTN
# there is no true echo cancellation, so the agent's own TTS leaks back as
# short residual blips (the "SPEECH -> SPEECH_ENDING -> SPEECH" flapping seen
# in the VAD logs) and each blip cuts the agent off mid-sentence. Raising the
# VAD thresholds to reject the echo also makes the agent deaf to the caller —
# no single threshold separates them.
#
# Fix: keep barge-in, but only trigger it once the caller has been continuously
# in SPEECH for BARGE_IN_MIN_MS. Real interruptions are sustained; echo blips
# flap back to SILENCE within tens of ms and never reach the bar. Evi stays
# fully interruptible without interrupting herself. Set BARGE_IN_MIN_MS=0 to
# restore the plugin's immediate barge-in.
_BARGE_IN_MIN_MS = int(os.environ.get("BARGE_IN_MIN_MS", "0"))
_FULL_DUPLEX_BARGE_IN_ENABLED = (
    os.environ.get("FULL_DUPLEX_BARGE_IN_ENABLED", "1") == "1"
    and _BARGE_IN_MIN_MS > 0
)
if _BARGE_IN_MIN_MS > 0:
    import asyncio as _asyncio
    from types import SimpleNamespace as _NS

    from deepslate.livekit.realtime import _model as _ds_bi
    from deepslate.livekit.realtime._model import InputSpeechStartedEvent as _ISSE

    def _sustained_barge_in(min_ms):
        async def _handler(self, from_state, to_state, session_time_ms, packet_id):
            if os.environ.get("DEEPSLATE_DIAG") == "1":
                print(f"[diag] VAD {from_state} -> {to_state} @{session_time_ms}ms pkt={packet_id}")

            # Keep the state on the individual Deepslate session. A worker can
            # host multiple calls, so process-global playout state would let
            # one conversation change another conversation's barge-in logic.
            self._rescova_vad_state = to_state
            playout_active = bool(getattr(self, "_rescova_playout_active", False))

            if to_state == "SPEECH":
                # A response generation can exist while the model is only
                # thinking or executing tools. Treat speech in that phase as
                # real caller input immediately; delaying it as if Evi were
                # audibly speaking can cancel the pending tool response and
                # leave the realtime session without a follow-up.
                if not playout_active:
                    self.emit("input_speech_started", _ISSE())
                    self._close_current_generation()
                # Caller entered confirmed speech while Evi is talking. Arm a
                # timer; only sustained speech actually interrupts her.
                elif getattr(self, "_bi_task", None) is None or self._bi_task.done():
                    async def _fire():
                        try:
                            await _asyncio.sleep(min_ms / 1000)
                            if getattr(self, "_rescova_vad_state", None) != "SPEECH":
                                return
                            self.emit("input_speech_started", _ISSE())
                            self._close_current_generation()
                            if os.environ.get("DEEPSLATE_DIAG") == "1":
                                print(f"[diag] barge-in fired (sustained {min_ms}ms)")
                        except _asyncio.CancelledError:
                            pass
                    self._bi_task = _asyncio.ensure_future(_fire())
            else:
                # Only uninterrupted SPEECH counts towards the gate. Cancel
                # on intermediate states such as SPEECH_ENDING as well as on
                # SILENCE, otherwise separate echo blips could add up to 600ms.
                task = getattr(self, "_bi_task", None)
                if task is not None and not task.done():
                    task.cancel()
                self._bi_task = None

            self.emit(
                "deepslate_server_event_received",
                _NS(
                    type="vad_state_event",
                    from_state=from_state,
                    to_state=to_state,
                    session_time_ms=session_time_ms,
                    packet_id=packet_id,
                ),
            )

        return _handler

    _ds_bi.DeepslateRealtimeSession.on_vad_state_event = _sustained_barge_in(_BARGE_IN_MIN_MS)

    _orig_resp_begin = _ds_model.DeepslateRealtimeSession.on_response_begin

    async def _resp_begin_diag(self, turn_id=0):
        print(f"[diag] response_begin turn={turn_id}")
        return await _orig_resp_begin(self, turn_id)

    _ds_model.DeepslateRealtimeSession.on_response_begin = _resp_begin_diag

    _orig_user_tx = _ds_model.DeepslateRealtimeSession.on_user_transcription

    async def _user_tx_diag(self, text, language, turn_id):
        print(f"[diag] user_transcription turn={turn_id}: {text!r}")
        return await _orig_user_tx(self, text, language, turn_id)

    _ds_model.DeepslateRealtimeSession.on_user_transcription = _user_tx_diag


# ── Case mode: tool-driven negotiation agent ────────────────────────────────
# Rooms dialed via POST /v1/cases/:id/call carry a `call_token` in metadata.
# Every tool below is a thin HTTP wrapper around the Node Tool Gateway
# (src/routes/agent-tools.js) — no business logic lives here. The gateway
# resolves the token to exactly one case, checks policy, executes, and logs;
# results are returned to the model verbatim as JSON strings.
TOOL_GATEWAY_URL = os.environ.get("TOOL_GATEWAY_URL", "http://127.0.0.1:3000")
INTERNAL_TOOL_SECRET = os.environ.get("INTERNAL_TOOL_SECRET", "")


async def load_initial_case_context(call_token: str) -> dict:
    """Load and audit the case context before the first model generation.

    Keeping this outside the opening model turn means the greeting consists of
    one uninterrupted speech generation. Only bounded name fields are used to
    construct that sentence; the model still loads the full tool result itself
    before discussing any case details.
    """
    timeout = aiohttp.ClientTimeout(total=10)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        async with http.post(
            f"{TOOL_GATEWAY_URL}/internal/tools/get_case_context",
            json={},
            headers={
                "x-internal-secret": INTERNAL_TOOL_SECRET,
                "x-call-token": call_token,
            },
        ) as resp:
            body = await resp.text()
            print(f"[agent] initial tool get_case_context -> {resp.status}")
            if resp.status != 200:
                raise RuntimeError(f"initial case context failed with status {resp.status}")
            try:
                payload = json.loads(body)
            except json.JSONDecodeError as error:
                raise RuntimeError("initial case context returned invalid JSON") from error
            if not isinstance(payload.get("case"), dict):
                raise RuntimeError("initial case context is incomplete")
            return payload


def opening_line(case_context: dict, organization_name: str, call_purpose: str = "campaign") -> str:
    """Build the first sentence from bounded DB fields, not model free-form."""
    def label(value: object, fallback: str, max_length: int = 80) -> str:
        cleaned = re.sub(r"[^\w\s.'&(),/\-]", " ", str(value or ""), flags=re.UNICODE)
        cleaned = " ".join(cleaned.split())[:max_length]
        return cleaned or fallback

    case = case_context["case"]
    organization = label(organization_name, "der zuständigen Organisation", 160)
    debtor = label(case.get("debtor_name"), "der zuständigen Person")
    if call_purpose == "callback":
        return (
            f"Guten Tag, hier ist erneut Evi, die digitale KI-Assistentin von {organization}. "
            "Ich rufe wie vereinbart zurück. "
            f"Spreche ich mit {debtor}, und passt es Ihnen jetzt?"
        )
    return (
        f"Guten Tag, hier ist Evi, die digitale KI-Assistentin von {organization}. "
        f"Spreche ich mit {debtor}, und passt es Ihnen gerade kurz?"
    )


class EviCase(Agent):
    def __init__(self, instructions: str, call_token: str) -> None:
        super().__init__(instructions=instructions)
        self._call_token = call_token
        self._http: Optional[aiohttp.ClientSession] = None

    async def _tool(self, name: str, payload: Optional[dict] = None) -> str:
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10))
        try:
            async with self._http.post(
                f"{TOOL_GATEWAY_URL}/internal/tools/{name}",
                json=payload or {},
                headers={
                    "x-internal-secret": INTERNAL_TOOL_SECRET,
                    "x-call-token": self._call_token,
                },
            ) as resp:
                body = await resp.text()
                print(f"[agent] tool {name} -> {resp.status}")
                return body
        except Exception as e:
            print(f"[agent] tool {name} failed: {e}")
            return json.dumps({
                "error": "tool_unavailable",
                "instructions": "Entschuldige dich kurz und sage, dass sich ein Kollege melden wird.",
            })

    @function_tool()
    async def get_case_context(self, context: RunContext) -> str:
        """Lädt die Falldaten und erlaubten Aktionen. Muss als allererste
        Aktion lautlos aufgerufen werden; der Toolname wird nie ausgesprochen."""
        return await self._tool("get_case_context")

    @function_tool()
    async def report_signal(self, context: RunContext, signal: str, note: str = "") -> str:
        """Meldet ein Gesprächssignal, z.B. dispute, already_paid, wrong_person,
        do_not_call, hardship, angry oder cannot_pay_in_full. Rückrufwünsche
        werden direkt mit schedule_callback verarbeitet.

        Args:
            signal: Das erkannte Signal.
            note: Kurze Notiz, was die Person gesagt hat.
        """
        return await self._tool("report_signal", {"signal": signal, "note": note})

    @function_tool()
    async def schedule_callback(
        self,
        context: RunContext,
        local_time: str = "",
        local_date: str = "",
        relative_minutes: int = 0,
    ) -> str:
        """Speichert einen klar gewünschten Rückruf direkt. Kein vorheriger
        report_signal-Aufruf und keine erneute Bestätigung nötig, wenn die
        Person bereits eine eindeutige Uhrzeit genannt hat.

        Args:
            local_time: Gewünschte lokale Uhrzeit im Format HH:mm. Bei einer
                relativen Angabe leer lassen.
            local_date: Lokales Datum YYYY-MM-DD. Leer lassen, wenn eindeutig
                ein späterer Zeitpunkt am heutigen Tag gemeint ist.
            relative_minutes: Nur für Angaben wie "in 10 Minuten" verwenden.
                Der Server berechnet daraus sicher Datum und Uhrzeit; dann
                local_time und local_date leer lassen.
        """
        return await self._tool("schedule_callback", {
            "local_date": local_date,
            "local_time": local_time,
            "relative_minutes": relative_minutes,
        })

    @function_tool()
    async def get_plan_options(self, context: RunContext) -> str:
        """Liefert die aktuell freigegebenen Zahlungsoptionen für diesen Fall.
        Nur diese Optionen dürfen angeboten werden — exakt wie beschrieben."""
        return await self._tool("get_plan_options")

    @function_tool()
    async def create_payment_plan(self, context: RunContext, option_token: str) -> str:
        """Bestätigt verbindlich die von der Person gewählte Zahlungsoption.

        Args:
            option_token: Das option_token der gewählten Option aus get_plan_options.
        """
        return await self._tool("create_payment_plan", {"option_token": option_token})

    @function_tool()
    async def log_call_outcome(self, context: RunContext, disposition: str, summary: str) -> str:
        """Protokolliert das Gesprächsergebnis. Immer vor dem Auflegen aufrufen.

        Args:
            disposition: Eine von: payment_promised, plan_agreed, paid_claimed,
                refused, no_agreement, callback_scheduled, wrong_person,
                disputed, escalated, voicemail, hung_up, other.
            summary: Kurze Zusammenfassung des Gesprächs.
        """
        return await self._tool("log_call_outcome", {"disposition": disposition, "summary": summary})

    @function_tool()
    async def escalate_to_human(self, context: RunContext, reason_code: str, summary: str = "") -> str:
        """Übergibt den Fall an einen menschlichen Mitarbeiter und stoppt die Automatisierung.

        Args:
            reason_code: Kurzer Grund, z.B. 'complex_case' oder 'requests_human'.
            summary: Kurze Zusammenfassung für den Mitarbeiter.
        """
        return await self._tool("escalate_to_human", {"reason_code": reason_code, "summary": summary})

    @function_tool()
    async def mark_disputed(self, context: RunContext, reason: str = "") -> str:
        """Markiert die Forderung als bestritten und stoppt jede weitere Automatisierung.

        Args:
            reason: Was die Person zur Begründung gesagt hat.
        """
        return await self._tool("mark_disputed", {"reason": reason})

    @function_tool()
    async def end_call(self, context: RunContext, reason: str = "") -> str:
        """Beendet den Anruf tatsächlich. NUR aufrufen, nachdem die Person
        ausdrücklich bestätigt hat, dass das Gespräch jetzt beendet werden darf.
        Nach diesem Aufruf noch eine kurze Verabschiedung sagen, aber kein
        weiteres Tool mehr aufrufen — der Anruf endet automatisch.

        Args:
            reason: Kurzer Grund für das Beenden, z.B. 'outcome_logged' oder 'person_confirmed'.
        """
        return await self._tool("end_call", {"reason": reason})


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: agents.JobContext):
    print(f"[agent] joining room: {ctx.room.name}")

    # Evi's server-controlled persona is passed in room metadata as JSON:
    # {"organization_name": "...", "system_prompt": "...", "greeting": "...",
    # "hosted_voice_id": "...", "temperature": 0.3, "mode": "case",
    # "call_token": "..."}.
    #
    # Read from ctx.job.room (the dispatch-time RoomInfo snapshot), not
    # ctx.room.metadata — the live Room object hasn't synced metadata yet by
    # the time the entrypoint runs, so ctx.room.metadata is reliably empty.
    room_metadata = ctx.job.room.metadata if ctx.job.room else None
    try:
        persona = json.loads(room_metadata or "")
    except (json.JSONDecodeError, TypeError):
        print("[agent] rejecting room: missing or invalid case metadata")
        return

    required_strings = (
        "call_token", "organization_name", "system_prompt", "greeting", "hosted_voice_id"
    )
    if (
        not isinstance(persona, dict)
        or persona.get("mode") != "case"
        or any(not isinstance(persona.get(key), str) or not persona[key].strip() for key in required_strings)
    ):
        print("[agent] rejecting room: incomplete or non-case metadata")
        return

    system_prompt = persona["system_prompt"]
    greeting = persona["greeting"]
    organization_name = persona["organization_name"]
    hosted_voice_id = persona["hosted_voice_id"]
    call_token = persona["call_token"]
    call_purpose = persona.get("call_purpose", "campaign")
    if call_purpose not in ("campaign", "callback"):
        print("[agent] rejecting room: invalid call purpose")
        return
    if call_purpose == "callback":
        system_prompt += (
            "\n\nSERVER-KONTEXT FÜR DIESEN ANRUF: Dies ist ein serverseitig "
            "gespeicherter und fälliger Rückruftermin. Du darfst dich darauf "
            "beziehen, dass dieser Rückruf vereinbart wurde."
        )
    try:
        temperature = float(persona.get("temperature", 0.3))
    except (TypeError, ValueError):
        print("[agent] rejecting room: invalid temperature")
        return

    try:
        await wait_for_outbound_sip_answer(ctx)
    except (TimeoutError, RuntimeError) as error:
        print(f"[agent] ending unanswered SIP job: {error}")
        ctx.shutdown(reason=str(error))
        return

    session = AgentSession(
        llm=deepslate.livekit.realtime.RealtimeModel(
            system_prompt=system_prompt,
            temperature=temperature,
            tts_config=build_tts_config(hosted_voice_id),
            # Server-side VAD thresholds, tunable without code changes.
            # Telephone audio is compressed/quieter than browser mic audio, so
            # the defaults (min_volume 0.01, confidence 0.5) may sit above what
            # a SIP call delivers — leaving the agent deaf after the greeting.
            vad_confidence_threshold=float(os.environ.get("VAD_CONFIDENCE_THRESHOLD", "0.3")),
            vad_min_volume=float(os.environ.get("VAD_MIN_VOLUME", "0.001")),
            vad_start_duration_ms=int(os.environ.get("VAD_START_DURATION_MS", "80")),
            vad_stop_duration_ms=int(os.environ.get("VAD_STOP_DURATION_MS", "350")),
        ),
        # A fixed AEC warmup can either expire before a long greeting ends or
        # hide the callee's first reply. The opening turn is gated exactly for
        # its playout duration below; subsequent turns remain interruptible.
        aec_warmup_duration=None,
    )

    # Every action is authorized by the Node Tool Gateway using the short-lived
    # call token resolved above. There is deliberately no non-case fallback.
    try:
        initial_context = await load_initial_case_context(call_token)
    except Exception as error:
        print(f"[agent] ending call without case context: {error}")
        ctx.shutdown(reason="initial case context unavailable")
        return

    agent = EviCase(system_prompt, call_token)

    await session.start(room=ctx.room, agent=agent)

    # This is a reversible rollout. Full duplex keeps caller audio flowing
    # while Evi speaks so the sustained-speech gate above can interrupt her.
    # Setting FULL_DUPLEX_BARGE_IN_ENABLED=0 restores the previous half-duplex
    # echo guard without reverting or redeploying code.
    def _guard_input_during_agent_speech(event) -> None:
        realtime_session = getattr(agent, "realtime_llm_session", None)
        if event.new_state == "speaking":
            if realtime_session is not None:
                realtime_session._rescova_playout_active = True
            if not _FULL_DUPLEX_BARGE_IN_ENABLED:
                session.input.set_audio_enabled(False)
                print("[agent] echo guard: input disabled during playout")
        elif event.old_state == "speaking":
            if realtime_session is not None:
                realtime_session._rescova_playout_active = False
            if not _FULL_DUPLEX_BARGE_IN_ENABLED:
                session.input.set_audio_enabled(True)
                print("[agent] echo guard: input re-enabled after playout")

    session.on("agent_state_changed", _guard_input_during_agent_speech)
    print(
        "[agent] barge-in mode: "
        f"{'full-duplex' if _FULL_DUPLEX_BARGE_IN_ENABLED else 'half-duplex'} "
        f"(sustained speech={_BARGE_IN_MIN_MS}ms)"
    )

    # Keep the opening interruptible so Evi can answer natural questions such
    # as "Wer ist da?" immediately. The system prompt treats the introduction,
    # name confirmation, and availability question as a mandatory checklist:
    # after answering the interruption, the model must resume every missing
    # item before it may discuss the case.
    guard_opening = not _FULL_DUPLEX_BARGE_IN_ENABLED
    if guard_opening:
        session.input.set_audio_enabled(False)
    try:
        opening_handle = session.generate_reply(
            instructions=(
                "Say exactly this German opening sentence and nothing else: "
                f"{opening_line(initial_context, organization_name, call_purpose)}"
            ),
            tools=[],
            allow_interruptions=True,
        )
        await opening_handle
    finally:
        if guard_opening:
            session.input.set_audio_enabled(True)

    # Ambience is disabled by default: mixing the bundled clip above its
    # documented 0..1 gain range caused clipping/muffling on narrowband calls.
    # It remains opt-in for controlled tests at a conservative gain.
    if os.environ.get("BACKGROUND_AUDIO_ENABLED", "0") == "1":
        try:
            ambient_volume = float(os.environ.get("BACKGROUND_AMBIENT_VOLUME", "0.15"))
            background_audio = BackgroundAudioPlayer(
                ambient_sound=AudioConfig(BuiltinAudioClip.OFFICE_AMBIENCE, volume=ambient_volume),
            )
            await background_audio.start(room=ctx.room, agent_session=session)
            print(f"[agent] background audio started (ambient={ambient_volume})")
        except Exception as e:
            print(f"[agent] background audio failed to start: {e!r}")


if __name__ == "__main__":
    agents.cli.run_app(server)
