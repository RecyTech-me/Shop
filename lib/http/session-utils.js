const { normalizeText } = require("../input-utils");
const logger = require("../logger");

const SAFE_REDIRECT_MAX_LENGTH = 2048;

function hasUnsafeRedirectCharacters(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (character === "\\" || codePoint <= 0x1f || codePoint === 0x7f) {
            return true;
        }
    }

    return false;
}

function setFlash(req, type, message, options = {}) {
    req.session.flash = { type, message, ...options };
}

function getFlash(req) {
    const flash = req.session.flash || null;
    delete req.session.flash;
    return flash;
}

function saveSessionAndRedirect(req, res, location) {
    req.session.save((error) => {
        if (error) {
            logger.error("session.save_failed", {
                requestId: req.requestId,
                path: req.path,
                error: error.message,
            });
            if (!res.headersSent) {
                return res.status(503).send("Service temporarily unavailable");
            }
            return;
        }

        res.redirect(location);
    });
}

function getSafeRedirectTarget(value, fallback = "/") {
    const input = normalizeText(value);
    if (
        !input
        || input.length > SAFE_REDIRECT_MAX_LENGTH
        || !input.startsWith("/")
        || input.startsWith("//")
        || hasUnsafeRedirectCharacters(input)
    ) {
        return fallback;
    }

    return input;
}

module.exports = {
    setFlash,
    getFlash,
    saveSessionAndRedirect,
    getSafeRedirectTarget,
};
