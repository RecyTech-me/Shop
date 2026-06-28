const { hashPassword } = require("../auth");

function nowIso() {
    return new Date().toISOString();
}

function getAdminByUsername(db, username) {
    return db.prepare(`
        SELECT id, username, password_hash, role, created_at
        FROM admins
        WHERE username = ?
    `).get(username);
}

function getAdminById(db, adminId) {
    return db.prepare("SELECT id, username, role, created_at FROM admins WHERE id = ?").get(adminId);
}

function listAdmins(db) {
    return db.prepare(`
        SELECT id, username, role, created_at
        FROM admins
        ORDER BY created_at ASC, id ASC
    `).all();
}

function countAdminsByRole(db, role) {
    return db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role = ?").get(role).count;
}

function createAdmin(db, input) {
    const timestamp = nowIso();
    const result = db.prepare(`
        INSERT INTO admins (username, password_hash, role, created_at)
        VALUES (?, ?, ?, ?)
    `).run(input.username, hashPassword(input.password), input.role || "admin", timestamp);

    return getAdminById(db, result.lastInsertRowid);
}

function updateAdmin(db, adminId, input) {
    const existing = getAdminById(db, adminId);
    if (!existing) {
        return null;
    }

    const nextPasswordHash = input.password ? hashPassword(input.password) : db.prepare(
        "SELECT password_hash FROM admins WHERE id = ?"
    ).get(adminId).password_hash;

    db.prepare(`
        UPDATE admins
        SET username = ?,
            password_hash = ?,
            role = ?
        WHERE id = ?
    `).run(input.username, nextPasswordHash, input.role || existing.role, adminId);

    return getAdminById(db, adminId);
}

function deleteAdmin(db, adminId) {
    return db.prepare("DELETE FROM admins WHERE id = ?").run(adminId).changes > 0;
}

module.exports = {
    getAdminByUsername,
    getAdminById,
    listAdmins,
    countAdminsByRole,
    createAdmin,
    updateAdmin,
    deleteAdmin,
};
