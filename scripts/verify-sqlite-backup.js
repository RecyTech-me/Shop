const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const rootDir = path.resolve(__dirname, "..");

function readArg(name) {
    const prefix = `${name}=`;
    const value = process.argv.find((arg) => arg.startsWith(prefix));
    return value ? value.slice(prefix.length).trim() : "";
}

function resolvePath(value, fallback = "") {
    const selected = value || fallback;
    return path.isAbsolute(selected) ? selected : path.join(rootDir, selected);
}

function verifyBackup(backupPath) {
    if (!backupPath) {
        throw new Error("Missing required backup path. Pass --backup=/path/to/backup.db");
    }

    const source = resolvePath(backupPath);
    if (!source || !fs.existsSync(source)) {
        throw new Error(`Backup file not found: ${source}`);
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-backup-verify-"));
    const restoredPath = path.join(tempDir, "restored-shop.db");

    try {
        fs.copyFileSync(source, restoredPath);
        const db = new Database(restoredPath, { readonly: true, fileMustExist: true });

        try {
            const integrity = db.prepare("PRAGMA integrity_check").get();
            if (integrity.integrity_check !== "ok") {
                throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`);
            }

            const schemaObjects = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master").get().count;
            const ordersTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get();

            return {
                restoredPath,
                schemaObjects,
                ordersTablePresent: Boolean(ordersTable),
            };
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function main() {
    const backupPath = readArg("--backup") || process.env.BACKUP_PATH;
    const result = verifyBackup(backupPath);

    console.log(`SQLite backup verified: ${path.resolve(backupPath)}`);
    console.log(`Schema objects: ${result.schemaObjects}`);
    console.log(`Orders table present: ${result.ordersTablePresent ? "yes" : "no"}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    readArg,
    resolvePath,
    verifyBackup,
};
