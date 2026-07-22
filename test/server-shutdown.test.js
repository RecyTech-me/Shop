const assert = require("node:assert/strict");
const test = require("node:test");
const logger = require("../lib/logger");
const { readListenPort } = require("../lib/config");
const { createGracefulShutdown } = require("../lib/server-lifecycle");

test("listen port parsing rejects partial and out-of-range values", () => {
    assert.equal(readListenPort("3100"), 3100);
    assert.equal(readListenPort(""), 3000);
    assert.throws(() => readListenPort("3100tcp"), /PORT must be an integer/);
    assert.throws(() => readListenPort("65536"), /PORT must be an integer/);
});

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

    const firstShutdown = shutdown("SIGTERM");
    const repeatedShutdown = shutdown("SIGINT");
    assert.equal(repeatedShutdown, firstShutdown);
    await firstShutdown;

    assert.deepEqual(calls, ["server.close", "runtime.stop"]);
    assert.deepEqual(exitCodes, [0]);
});

test("graceful shutdown exits with failure when HTTP close fails", async () => {
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

    await shutdown("SIGTERM");

    assert.deepEqual(calls, ["server.close", "runtime.stop"]);
    assert.deepEqual(exitCodes, [1]);
});

test("graceful shutdown waits for asynchronous runtime cleanup", async () => {
    let finishCleanup;
    const cleanup = new Promise((resolve) => {
        finishCleanup = resolve;
    });
    const calls = [];
    const shutdown = createGracefulShutdown({
        server: {
            close(callback) {
                calls.push("server.close");
                callback();
            },
        },
        app: {
            locals: {
                runtime: {
                    async stop() {
                        calls.push("runtime.stop:start");
                        await cleanup;
                        calls.push("runtime.stop:end");
                    },
                },
            },
        },
        exit: (code) => calls.push(`exit:${code}`),
        timeoutMs: 100,
    });

    const pendingShutdown = shutdown("SIGTERM");
    await Promise.resolve();
    assert.deepEqual(calls, ["server.close", "runtime.stop:start"]);

    finishCleanup();
    await pendingShutdown;
    assert.deepEqual(calls, ["server.close", "runtime.stop:start", "runtime.stop:end", "exit:0"]);
});

test("graceful shutdown exits with failure when runtime cleanup fails", async () => {
    const exitCodes = [];
    const shutdown = createGracefulShutdown({
        server: {
            close(callback) {
                callback();
            },
        },
        app: {
            locals: {
                runtime: {
                    async stop() {
                        throw new Error("cleanup failed");
                    },
                },
            },
        },
        exit: (code) => exitCodes.push(code),
        timeoutMs: 100,
    });

    assert.equal(await shutdown("SIGTERM"), 1);
    assert.deepEqual(exitCodes, [1]);
});
