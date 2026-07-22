const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const rootDir = path.resolve(__dirname, "..");

function timestamp() {
    return new Date().toISOString()
        .replace(/[:.]/g, "")
        .replace("T", "-")
        .replace("Z", "Z");
}

function readArg(name) {
    const prefix = `${name}=`;
    const value = process.argv.find((arg) => arg.startsWith(prefix));
    return value ? value.slice(prefix.length).trim() : "";
}

function resolvePath(value, fallback) {
    const selected = value || fallback;
    return path.isAbsolute(selected) ? selected : path.join(rootDir, selected);
}

async function main() {
    const source = resolvePath(
        readArg("--database") || process.env.DATABASE_PATH,
        "storage/shop.db"
    );
    const backupDir = resolvePath(
        readArg("--out-dir") || process.env.BACKUP_DIR,
        "storage/backups"
    );

    if (!fs.existsSync(source)) {
        throw new Error(`Database file not found: ${source}`);
    }

    const previousUmask = process.umask(0o077);
    let destination = "";
    try {
        fs.mkdirSync(backupDir, { recursive: true });
        destination = path.join(backupDir, `shop-${timestamp()}.db`);
        const db = new Database(source, { readonly: true, fileMustExist: true });

        try {
            await db.backup(destination);
        } finally {
            db.close();
        }
        fs.chmodSync(destination, 0o600);

        const backup = new Database(destination, { readonly: true, fileMustExist: true });
        try {
            const integrity = backup.prepare("PRAGMA integrity_check").get();
            if (integrity.integrity_check !== "ok") {
                throw new Error(`SQLite backup integrity check failed: ${integrity.integrity_check}`);
            }
        } finally {
            backup.close();
        }

        const sizeBytes = fs.statSync(destination).size;
        console.log(`SQLite backup written and verified: ${destination} (${sizeBytes} bytes)`);
    } catch (error) {
        if (destination) {
            fs.rmSync(destination, { force: true });
        }
        throw error;
    } finally {
        process.umask(previousUmask);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    main,
    readArg,
    resolvePath,
};
