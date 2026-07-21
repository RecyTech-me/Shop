const assert = require("node:assert/strict");
const test = require("node:test");
const { hashPassword, verifyPasswordAsync } = require("../lib/auth");
const database = require("../lib/db");
const { getAuthenticatedAdmin } = require("../lib/http/admin-auth");

test("asynchronous password verification preserves valid and invalid results", async () => {
    const passwordHash = hashPassword("correct-password");

    assert.equal(await verifyPasswordAsync("correct-password", passwordHash), true);
    assert.equal(await verifyPasswordAsync("wrong-password", passwordHash), false);
    assert.equal(await verifyPasswordAsync("correct-password", "invalid"), false);
});

test("credential changes increment the auth version and invalidate older sessions", (t) => {
    const db = database.initializeDatabase(":memory:", {
        NODE_ENV: "test",
        ADMIN_USERNAME: "root",
        ADMIN_PASSWORD: "initial-password",
    });
    t.after(() => db.close());
    const original = database.getAdminByUsername(db, "root");

    const unchanged = database.updateAdmin(db, original.id, {
        username: original.username,
        role: original.role,
        password: "",
    });
    assert.equal(unchanged.auth_version, original.auth_version);

    const updated = database.updateAdmin(db, original.id, {
        username: original.username,
        role: original.role,
        password: "new-secure-password",
    });
    assert.equal(updated.auth_version, original.auth_version + 1);

    const staleRequest = {
        session: {
            adminId: original.id,
            adminAuthVersion: original.auth_version,
        },
    };
    assert.equal(getAuthenticatedAdmin(staleRequest, db, database.getAdminById), null);
    assert.equal(staleRequest.session.adminId, undefined);

    const currentRequest = {
        session: {
            adminId: original.id,
            adminAuthVersion: updated.auth_version,
        },
    };
    assert.equal(
        getAuthenticatedAdmin(currentRequest, db, database.getAdminById).id,
        original.id
    );
});
