const assert = require("node:assert/strict");
const test = require("node:test");
const {
    getPublicErrorResponse,
    isInternalPublicError,
} = require("../lib/http/public-errors");

test("public error responses preserve validation messages", () => {
    const response = getPublicErrorResponse(new Error("Adresse invalide."), "Réessayez.");

    assert.deepEqual(response, {
        internal: false,
        message: "Adresse invalide.",
        statusCode: 400,
    });
});

test("public error responses hide database and runtime internals", () => {
    const busyError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const constraintError = Object.assign(new Error("orders.idempotency_key"), { code: "SQLITE_CONSTRAINT_UNIQUE" });

    assert.equal(isInternalPublicError(busyError), true);
    assert.deepEqual(getPublicErrorResponse(busyError, "Réessayez."), {
        internal: true,
        message: "Réessayez.",
        statusCode: 503,
    });
    assert.equal(getPublicErrorResponse(constraintError, "Réessayez.").statusCode, 500);
    assert.equal(getPublicErrorResponse(new TypeError("secret implementation detail"), "Réessayez.").message, "Réessayez.");
});
