const crypto = require("crypto");
const { normalizeText } = require("../input-utils");

function getOrCreateCsrfToken(req) {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(24).toString("hex");
    }

    return req.session.csrfToken;
}

function isValidCsrfToken(req) {
    const sessionToken = req.session?.csrfToken;
    const incomingToken = normalizeText(req.body?._csrf || req.headers["x-csrf-token"] || req.headers["csrf-token"]);

    if (!sessionToken || !incomingToken) {
        return false;
    }

    const expected = Buffer.from(sessionToken, "utf8");
    const provided = Buffer.from(incomingToken, "utf8");

    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

module.exports = {
    getOrCreateCsrfToken,
    isValidCsrfToken,
};
