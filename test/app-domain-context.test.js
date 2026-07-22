const assert = require("node:assert/strict");
const test = require("node:test");
const { createReservationCleanupTimers } = require("../lib/app-domain-context");
const { cleanupRejectedUploads } = require("../lib/http/app-middleware");
const logger = require("../lib/logger");

logger.configureLogger({ level: "silent" });

test("reservation cleanup is single-flight when timer runs overlap", async () => {
    let calls = 0;
    let finishCleanup;
    const pendingCleanup = new Promise((resolve) => {
        finishCleanup = resolve;
    });
    const timers = createReservationCleanupTimers({
        backgroundTasksEnabled: false,
        cleanupIntervalMs: 0,
        paymentReservationCleanup: {
            cleanupStaleReservations: async () => {
                calls += 1;
                await pendingCleanup;
            },
        },
    });

    const first = timers.runNow();
    const second = timers.runNow();
    assert.equal(first, second);
    assert.equal(calls, 0);

    await Promise.resolve();
    assert.equal(calls, 1);
    finishCleanup();
    await first;

    await timers.runNow();
    assert.equal(calls, 2);
    timers.stop();
});

test("reservation cleanup reports an in-flight task failure during shutdown", async () => {
    let failCleanup;
    const cleanupGate = new Promise((resolve) => {
        failCleanup = resolve;
    });
    const timers = createReservationCleanupTimers({
        backgroundTasksEnabled: false,
        cleanupIntervalMs: 0,
        paymentReservationCleanup: {
            cleanupStaleReservations: async () => {
                await cleanupGate;
                throw new Error("cleanup failed");
            },
        },
    });

    const backgroundRun = timers.runNow();
    await Promise.resolve();
    const shutdown = timers.stop();
    failCleanup();

    await backgroundRun;
    await assert.rejects(shutdown, /cleanup failed/);
});

test("CSRF rejection removes already parsed multipart uploads", () => {
    const calls = [];
    const req = {
        productUploadsParsed: true,
        settingsUploadParsed: true,
    };

    cleanupRejectedUploads(req, {
        cleanupProductUploads: (request) => calls.push(["product", request]),
        cleanupSettingsUpload: (request) => calls.push(["settings", request]),
    });

    assert.deepEqual(calls, [["product", req], ["settings", req]]);
});
