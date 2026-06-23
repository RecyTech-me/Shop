const { normalizeText } = require("../input-utils");

function setFlash(req, type, message, options = {}) {
    req.session.flash = { type, message, ...options };
}

function getFlash(req) {
    const flash = req.session.flash || null;
    delete req.session.flash;
    return flash;
}

function saveSessionAndRedirect(req, res, location) {
    req.session.save(() => {
        res.redirect(location);
    });
}

function getSafeRedirectTarget(value, fallback = "/") {
    const input = normalizeText(value);
    if (!input || !input.startsWith("/") || input.startsWith("//") || /[\r\n\\]/.test(input)) {
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
