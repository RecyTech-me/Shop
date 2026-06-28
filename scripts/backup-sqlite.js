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

    fs.mkdirSync(backupDir, { recursive: true });
    const destination = path.join(backupDir, `shop-${timestamp()}.db`);
    const db = new Database(source, { readonly: true, fileMustExist: true });

    try {
        await db.backup(destination);
    } finally {
        db.close();
    }

    const sizeBytes = fs.statSync(destination).size;
    console.log(`SQLite backup written: ${destination} (${sizeBytes} bytes)`);
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
