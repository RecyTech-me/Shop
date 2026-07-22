const { normalizeText } = require("../input-utils");

function getRequestIp(req) {
    return normalizeText(req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
}

function createAttemptRateLimiter({
    windowMs,
    blockMs,
    maxAttempts,
    maxKeys = 1000,
    getKey = getRequestIp,
}) {
    const tracker = new Map();

    function prune(now = Date.now()) {
        for (const [key, value] of tracker.entries()) {
            const expiresAt = Math.max(value.blockedUntil || 0, (value.firstAttemptAt || 0) + windowMs);
            if (!expiresAt || expiresAt <= now) {
                tracker.delete(key);
            }
        }

        while (tracker.size > maxKeys) {
            tracker.delete(tracker.keys().next().value);
        }
    }

    function getState(req) {
        prune();
        const key = getKey(req);
        const now = Date.now();
        const current = tracker.get(key);

        if (!current) {
            return {
                key,
                attempts: 0,
                blockedUntil: 0,
            };
        }

        if (current.blockedUntil && current.blockedUntil > now) {
            return {
                key,
                attempts: current.attempts || maxAttempts,
                blockedUntil: current.blockedUntil,
            };
        }

        if (!current.firstAttemptAt || (now - current.firstAttemptAt) > windowMs) {
            tracker.delete(key);
            return {
                key,
                attempts: 0,
                blockedUntil: 0,
            };
        }

        return {
            key,
            attempts: current.attempts || 0,
            blockedUntil: 0,
        };
    }

    function registerAttempt(req) {
        const state = getState(req);
        const now = Date.now();
        const nextAttempts = state.attempts + 1;

        tracker.set(state.key, {
            firstAttemptAt: state.attempts ? tracker.get(state.key)?.firstAttemptAt || now : now,
            attempts: nextAttempts,
            blockedUntil: nextAttempts >= maxAttempts ? now + blockMs : 0,
        });
        prune(now);
    }

    function clear(req) {
        tracker.delete(getKey(req));
    }

    return {
        getState,
        registerAttempt,
        clear,
        prune,
    };
}

function startRateLimitPruning(limiters, intervalMs) {
    const interval = setInterval(() => {
        for (const limiter of limiters) {
            limiter.prune();
        }
    }, intervalMs);
    interval.unref?.();
    return interval;
}

module.exports = {
    createAttemptRateLimiter,
    getRequestIp,
    startRateLimitPruning,
};
