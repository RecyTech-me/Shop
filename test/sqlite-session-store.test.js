const assert = require("node:assert/strict");
const test = require("node:test");
const database = require("../lib/db");
const { SqliteSessionStore } = require("../lib/sqlite-session-store");

test("session store cleanup can be stopped during graceful shutdown", (t) => {
    const db = database.initializeDatabase(":memory:", {
        NODE_ENV: "test",
        ADMIN_PASSWORD: "test-admin-password",
    });
    t.after(() => db.close());
    const store = new SqliteSessionStore(db, { cleanupIntervalMs: 1000 });

    assert.ok(store.cleanupTimer);
    store.close();
    assert.equal(store.cleanupTimer, null);
    store.close();
});

test("session store removes corrupt serialized sessions instead of failing every request", async (t) => {
    const db = database.initializeDatabase(":memory:", {
        NODE_ENV: "test",
        ADMIN_PASSWORD: "test-admin-password",
    });
    t.after(() => db.close());
    const store = new SqliteSessionStore(db, { cleanupIntervalMs: 0 });
    db.prepare("INSERT INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)")
        .run("corrupt-session", "{not-json", Date.now() + 60_000);

    const value = await new Promise((resolve, reject) => {
        store.get("corrupt-session", (error, sessionData) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(sessionData);
        });
    });

    assert.equal(value, null);
    assert.equal(db.prepare("SELECT sid FROM sessions WHERE sid = ?").get("corrupt-session"), undefined);
});
