'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function zonedParts(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone || 'Europe/Berlin',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return {
        day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday')),
        minute: Number(part('hour')) * 60 + Number(part('minute')),
    };
}

function timeMinutes(value) {
    const [hour, minute] = String(value || '').split(':').map(Number);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0;
}

function isWithinWindow(date, config) {
    const local = zonedParts(date, config.timezone);
    return config.weekdays.map(Number).includes(local.day)
        && local.minute >= timeMinutes(config.start_time)
        && local.minute < timeMinutes(config.end_time);
}

function capReleaseAt(now, attemptTimes, windowMs, maxAttempts) {
    const recent = attemptTimes
        .map((value) => new Date(value).getTime())
        .filter((value) => Number.isFinite(value) && value > now.getTime() - windowMs)
        .sort((a, b) => b - a);
    if (recent.length < maxAttempts) return now;
    return new Date(recent[maxAttempts - 1] + windowMs);
}

function nextWindowAt(notBefore, config) {
    const candidate = new Date(notBefore);
    candidate.setUTCSeconds(0, 0);
    if (candidate < notBefore) candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    const deadline = candidate.getTime() + 8 * DAY_MS;
    while (candidate.getTime() <= deadline) {
        if (isWithinWindow(candidate, config)) return new Date(candidate);
        candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    }
    return null;
}

function nextEligibleAt({ now = new Date(), notBefore = now, config, attemptTimes = [] }) {
    const dailyLimit = Math.max(1, Number(config.max_attempts_per_24h) || 1);
    const weeklyLimit = Math.max(dailyLimit, Number(config.max_attempts_per_7d) || 3);
    const daily = capReleaseAt(now, attemptTimes, DAY_MS, dailyLimit);
    const weekly = capReleaseAt(now, attemptTimes, WEEK_MS, weeklyLimit);
    const earliest = new Date(Math.max(now.getTime(), new Date(notBefore).getTime(), daily.getTime(), weekly.getTime()));
    const next = earliest.getTime() <= now.getTime() && isWithinWindow(now, config)
        ? new Date(now)
        : nextWindowAt(earliest, config);
    let reason = null;
    if (daily.getTime() > now.getTime()) reason = 'attempt_limit_24h';
    if (weekly.getTime() > now.getTime() && weekly.getTime() >= daily.getTime()) reason = 'attempt_limit_7d';
    if (!reason && !isWithinWindow(earliest, config)) reason = 'outside_campaign_window';
    return { next, reason };
}

function nextCampaignAttemptAt({ isDemo = false, now = new Date(), notBefore = now, config, attemptTimes = [] }) {
    if (isDemo) {
        return {
            next: new Date(Math.max(now.getTime(), new Date(notBefore).getTime())),
            reason: null,
        };
    }
    return nextEligibleAt({ now, notBefore, config, attemptTimes });
}

module.exports = { isWithinWindow, nextEligibleAt, nextCampaignAttemptAt };
