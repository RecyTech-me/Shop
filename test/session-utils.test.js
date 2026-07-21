const assert = require("node:assert/strict");
const test = require("node:test");
const logger = require("../lib/logger");
const { getSafeRedirectTarget, saveSessionAndRedirect } = require("../lib/http/session-utils");
const { sendJsonAfterSessionSave } = require("../routes/public-api");

logger.configureLogger({ level: "silent" });

function createResponse() {
    return {
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
        redirect(location) {
            this.redirectedTo = location;
            return this;
        },
    };
}

test("redirects are withheld when session persistence fails", () => {
    const req = {
        path: "/cart",
        session: {
            save(callback) {
                callback(new Error("disk full"));
            },
        },
    };
    const res = createResponse();

    saveSessionAndRedirect(req, res, "/checkout");

    assert.equal(res.statusCode, 503);
    assert.equal(res.redirectedTo, undefined);
});

test("JSON responses report session persistence failures", () => {
    const req = {
        path: "/checkout/session",
        session: {
            save(callback) {
                callback(new Error("database unavailable"));
            },
        },
    };
    const res = createResponse();

    sendJsonAfterSessionSave(req, res, { ok: true });

    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /enregistrer la session/);
});

test("local redirect targets reject unsafe header content and excessive lengths", () => {
    assert.equal(getSafeRedirectTarget("/products/example?tab=details", "/"), "/products/example?tab=details");
    assert.equal(getSafeRedirectTarget("https://evil.example", "/safe"), "/safe");
    assert.equal(getSafeRedirectTarget("//evil.example", "/safe"), "/safe");
    assert.equal(getSafeRedirectTarget("/cart\u0000injected", "/safe"), "/safe");
    assert.equal(getSafeRedirectTarget(`/${"a".repeat(2048)}`, "/safe"), "/safe");
});
