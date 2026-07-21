const crypto = require("node:crypto");

function createRequestId(req) {
    const incomingRequestId = String(req.get("x-request-id") || "").trim();
    if (/^[a-zA-Z0-9._:-]{8,128}$/.test(incomingRequestId)) {
        return incomingRequestId;
    }

    return crypto.randomUUID();
}

module.exports = { createRequestId };
