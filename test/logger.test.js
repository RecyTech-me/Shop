const assert = require("node:assert/strict");
const test = require("node:test");
const logger = require("../lib/logger");

function captureConsole(method, callback) {
    const original = console[method];
    const calls = [];

    console[method] = (...values) => {
        calls.push(values);
    };

    try {
        callback(calls);
    } finally {
        console[method] = original;
        logger.configureLogger({ level: "silent" });
    }

    return calls;
}

test("logger silent mode suppresses output", () => {
    const calls = captureConsole("log", () => {
        logger.configureLogger({ level: "silent" });
        logger.info("hidden");
    });

    assert.deepEqual(calls, []);
});

test("logger emits structured JSON entries with metadata", () => {
    const calls = captureConsole("error", () => {
        logger.configureLogger({ level: "debug", format: "json" });
        logger.error("payment.failed", {
            requestId: "req-test",
            error: {
                message: "boom",
            },
        });
    });

    assert.equal(calls.length, 1);
    const entry = JSON.parse(calls[0][0]);

    assert.equal(entry.level, "error");
    assert.equal(entry.message, "payment.failed");
    assert.equal(entry.metadata.requestId, "req-test");
    assert.equal(entry.metadata.error.message, "boom");
    assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
