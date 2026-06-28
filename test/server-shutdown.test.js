const assert = require("node:assert/strict");
const test = require("node:test");
const logger = require("../lib/logger");
const { createGracefulShutdown } = require("../lib/server-lifecycle");

logger.configureLogger({ level: "silent" });

test("graceful shutdown closes the HTTP server, stops runtime, and exits cleanly", async () => {
    const calls = [];
    const server = {
        close(callback) {
            calls.push("server.close");
            callback();
        },
    };
    const app = {
        locals: {
            runtime: {
                stop() {
                    calls.push("runtime.stop");
                },
            },
        },
    };
    const exitCodes = [];
    const shutdown = createGracefulShutdown({
        server,
        app,
        exit: (code) => exitCodes.push(code),
        timeoutMs: 100,
    });

    shutdown("SIGTERM");
    shutdown("SIGINT");

    assert.deepEqual(calls, ["server.close", "runtime.stop"]);
    assert.deepEqual(exitCodes, [0]);
});

test("graceful shutdown exits with failure when HTTP close fails", () => {
    const calls = [];
    const server = {
        close(callback) {
            calls.push("server.close");
            callback(new Error("close failed"));
        },
    };
    const app = {
        locals: {
            runtime: {
                stop() {
                    calls.push("runtime.stop");
                },
            },
        },
    };
    const exitCodes = [];
    const shutdown = createGracefulShutdown({
        server,
        app,
        exit: (code) => exitCodes.push(code),
        timeoutMs: 100,
    });

    shutdown("SIGTERM");

    assert.deepEqual(calls, ["server.close", "runtime.stop"]);
    assert.deepEqual(exitCodes, [1]);
});
