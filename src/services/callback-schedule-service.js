'use strict';

const { isWithinWindow } = require('./campaign-schedule-service');

const MIN_CALLBACK_LEAD_MS = 5 * 60 * 1000;
const MAX_CALLBACK_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CALLBACK_LATENESS_MS = 15 * 60 * 1000;

function minimumCallbackAt(now) {
    const minuteStart = new Date(now);
    minuteStart.setUTCSeconds(0, 0);
    return new Date(minuteStart.getTime() + MIN_CALLBACK_LEAD_MS);
}

function zonedDateTimeParts(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type) => parts.find((part) => part.type === type)?.value;
    return {
        year: Number(value('year')),
        month: Number(value('month')),
        day: Number(value('day')),
        hour: Number(value('hour')),
        minute: Number(value('minute')),
    };
}

function localDateTime(date, timezone) {
    const parts = zonedDateTimeParts(date, timezone);
    const pad = (value) => String(value).padStart(2, '0');
    return {
        date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
        time: `${pad(parts.hour)}:${pad(parts.minute)}`,
    };
}

function resolveRelativeCallback(relativeMinutes, timezone, now = new Date()) {
    const minutes = Number(relativeMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 30 * 24 * 60) {
        return { ok: false, reason: 'invalid_relative_callback' };
    }
    // Tool inputs only carry HH:mm. Round up so processing latency can never
    // turn a valid "in five minutes" request into a too-soon appointment.
    const targetMs = now.getTime() + minutes * 60_000;
    const target = new Date(Math.ceil(targetMs / 60_000) * 60_000);
    let local;
    try {
        local = localDateTime(target, timezone);
    } catch {
        return { ok: false, reason: 'invalid_callback_timezone' };
    }
    return { ok: true, localDate: local.date, localTime: local.time };
}

function callbackExecutionBlockReason({
    scheduledAt,
    config,
    isDemo = false,
    now = new Date(),
}) {
    const callbackAt = new Date(scheduledAt);
    if (Number.isNaN(callbackAt.getTime())) return 'invalid_callback_time';
    if (now.getTime() - callbackAt.getTime() > MAX_CALLBACK_LATENESS_MS) {
        return 'callback_missed';
    }
    if (!isDemo && !isWithinWindow(callbackAt, config)) {
        return 'callback_outside_updated_window';
    }
    return null;
}

function parseLocalCallback(dateValue, timeValue, timezone) {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
    if (!dateMatch) return { ok: false, reason: 'invalid_callback_date' };
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(timeValue || ''));
    if (!timeMatch) return { ok: false, reason: 'invalid_callback_time' };

    const target = {
        year: Number(dateMatch[1]),
        month: Number(dateMatch[2]),
        day: Number(dateMatch[3]),
        hour: Number(timeMatch[1]),
        minute: Number(timeMatch[2]),
    };
    const calendarCheck = new Date(Date.UTC(target.year, target.month - 1, target.day));
    if (calendarCheck.getUTCFullYear() !== target.year ||
        calendarCheck.getUTCMonth() + 1 !== target.month ||
        calendarCheck.getUTCDate() !== target.day) {
        return { ok: false, reason: 'invalid_callback_date' };
    }
    if (target.hour > 23 || target.minute > 59) {
        return { ok: false, reason: 'invalid_callback_time' };
    }

    try {
        new Intl.DateTimeFormat('en', { timeZone: timezone }).format(calendarCheck);
    } catch {
        return { ok: false, reason: 'invalid_callback_timezone' };
    }

    // Search the possible UTC offsets rather than guessing one. This rejects
    // nonexistent and ambiguous local times at DST transitions instead of
    // silently moving a confirmed appointment.
    const center = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
    const matches = [];
    for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 1) {
        const candidate = new Date(center + offsetMinutes * 60_000);
        const parts = zonedDateTimeParts(candidate, timezone);
        if (Object.keys(target).every((key) => parts[key] === target[key])) matches.push(candidate);
    }
    if (matches.length !== 1) {
        return { ok: false, reason: 'ambiguous_or_nonexistent_callback_time' };
    }
    return { ok: true, at: matches[0] };
}

function validateCallbackSchedule({
    localDate,
    localTime,
    config,
    isDemo = false,
    now = new Date(),
}) {
    const timezone = config.timezone || 'Europe/Berlin';
    let resolvedLocalDate = String(localDate || '').trim();
    const earliestCallback = minimumCallbackAt(now);
    if (!resolvedLocalDate) {
        const today = localDateTime(now, timezone).date;
        const todayResult = parseLocalCallback(today, localTime, timezone);
        if (!todayResult.ok) return todayResult;
        if (todayResult.at.getTime() < earliestCallback.getTime()) {
            return { ok: false, reason: 'callback_date_required' };
        }
        resolvedLocalDate = today;
    }

    const parsed = parseLocalCallback(resolvedLocalDate, localTime, timezone);
    if (!parsed.ok) return parsed;
    if (resolvedLocalDate < localDateTime(now, timezone).date) {
        return { ok: false, reason: 'callback_date_in_past' };
    }
    const callbackAt = parsed.at;
    if (callbackAt.getTime() < earliestCallback.getTime()) {
        return { ok: false, reason: 'callback_too_soon' };
    }
    if (callbackAt.getTime() > now.getTime() + MAX_CALLBACK_HORIZON_MS) {
        return { ok: false, reason: 'callback_too_far' };
    }
    if (!isDemo && !isWithinWindow(callbackAt, config)) {
        return { ok: false, reason: 'outside_campaign_window' };
    }
    return { ok: true, at: callbackAt, localDate: resolvedLocalDate };
}

function formatCallbackAt(date, timezone) {
    return new Intl.DateTimeFormat('de-DE', {
        timeZone: timezone || 'Europe/Berlin',
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

module.exports = {
    MIN_CALLBACK_LEAD_MS,
    MAX_CALLBACK_HORIZON_MS,
    MAX_CALLBACK_LATENESS_MS,
    localDateTime,
    resolveRelativeCallback,
    parseLocalCallback,
    validateCallbackSchedule,
    callbackExecutionBlockReason,
    formatCallbackAt,
};
