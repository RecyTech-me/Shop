const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const Database = require("better-sqlite3");
const { parseCoverage, readThreshold } = require("../scripts/check-coverage");
const syntaxScript = require("../scripts/check-syntax");
const wordpressImportScript = require("../scripts/import-wordpress-shop");
const { verifyBackup } = require("../scripts/verify-sqlite-backup");
const {
    buildAlertPayload,
    checkHealth,
    defaultHealthUrl,
    isHealthyPayload,
    readPositiveInteger,
} = require("../scripts/check-health");

const rootDir = path.join(__dirname, "..");

test("coverage parser reads all-file summary", () => {
    const coverage = parseCoverage(`
        file      | line % | branch % | funcs %
        all files | 79.29  | 60.86    | 82.30
    `);

    assert.deepEqual(coverage, {
        line: 79.29,
        branch: 60.86,
        funcs: 82.3,
    });
});

test("coverage thresholds reject partial and out-of-range environment values", (t) => {
    const originalValue = process.env.COVERAGE_AUDIT_TEST;
    t.after(() => {
        if (originalValue === undefined) {
            delete process.env.COVERAGE_AUDIT_TEST;
        } else {
            process.env.COVERAGE_AUDIT_TEST = originalValue;
        }
    });

    process.env.COVERAGE_AUDIT_TEST = "87.5";
    assert.equal(readThreshold("COVERAGE_AUDIT_TEST", 80), 87.5);
    process.env.COVERAGE_AUDIT_TEST = "87percent";
    assert.equal(readThreshold("COVERAGE_AUDIT_TEST", 80), 80);
    process.env.COVERAGE_AUDIT_TEST = "101";
    assert.equal(readThreshold("COVERAGE_AUDIT_TEST", 80), 80);
});

test("operational scripts are safe to import", () => {
    assert.equal(typeof syntaxScript.main, "function");
    assert.equal(typeof syntaxScript.checkNodeFile, "function");
    assert.equal(typeof wordpressImportScript.parseArgs, "function");
    assert.deepEqual(wordpressImportScript.parseArgs([
        "--wp-root",
        "/tmp/wp",
        "--sqlite",
        "/tmp/shop.db",
        "--report",
        "/tmp/report.json",
    ]), {
        wpRoot: "/tmp/wp",
        sqlite: "/tmp/shop.db",
        report: "/tmp/report.json",
    });
});

test("health check URL defaults prefer explicit health URL, public URL, then localhost", () => {
    assert.equal(
        defaultHealthUrl({ HEALTHCHECK_URL: "https://checks.example.test/ready" }),
        "https://checks.example.test/ready"
    );
    assert.equal(
        defaultHealthUrl({ SHOP_PUBLIC_URL: "https://shop.example.test/" }),
        "https://shop.example.test/healthz"
    );
    assert.equal(
        defaultHealthUrl({ BASE_URL: "https://base.example.test/store" }),
        "https://base.example.test/store/healthz"
    );
    assert.equal(defaultHealthUrl({ PORT: "4180" }), "http://127.0.0.1:4180/healthz");
});

test("health payload validator requires ok database status", () => {
    assert.equal(isHealthyPayload({ status: "ok", checks: { database: "ok" } }), true);
    assert.equal(isHealthyPayload({ status: "ok", checks: { database: "failed" } }), false);
    assert.equal(isHealthyPayload({ status: "failed", checks: { database: "ok" } }), false);
});

test("health retry settings accept only positive integers", () => {
    assert.equal(readPositiveInteger("5", 1), 5);
    assert.equal(readPositiveInteger("0", 3), 3);
    assert.equal(readPositiveInteger("5attempts", 4), 4);
    assert.equal(readPositiveInteger("invalid", 2), 2);
});

test("health alert payload preserves failure context", () => {
    const payload = buildAlertPayload({
        url: "https://shop.example.test/healthz",
        error: new Error("database unavailable"),
        statusCode: 503,
    });

    assert.equal(payload.service, "recytech-shop-site");
    assert.equal(payload.check, "healthz");
    assert.equal(payload.url, "https://shop.example.test/healthz");
    assert.equal(payload.status, "failed");
    assert.equal(payload.statusCode, 503);
    assert.equal(payload.error, "database unavailable");
    assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("health check posts an alert when the health endpoint fails", async (t) => {
    const originalFetch = global.fetch;
    const calls = [];

    t.after(() => {
        global.fetch = originalFetch;
    });

    global.fetch = async (url, options = {}) => {
        calls.push({ url, options });
        if (url === "https://alerts.example.test/hooks/health") {
            return {
                ok: true,
                status: 204,
                json: async () => null,
            };
        }

        return {
            ok: false,
            status: 503,
            json: async () => ({ status: "failed", checks: { database: "failed" } }),
        };
    };

    await assert.rejects(checkHealth({
        healthUrl: "https://shop.example.test/healthz",
        alertWebhookUrl: "https://alerts.example.test/hooks/health",
    }), /Health check failed/);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://shop.example.test/healthz");
    assert.equal(calls[1].url, "https://alerts.example.test/hooks/health");
    assert.equal(calls[1].options.method, "POST");
    assert.equal(JSON.parse(calls[1].options.body).statusCode, 503);
});

test("health check retries startup failures and does not alert after recovery", async () => {
    let healthAttempts = 0;
    let waitCalls = 0;
    const payload = await checkHealth({
        healthUrl: "https://shop.example.test/healthz",
        alertWebhookUrl: "https://alerts.example.test/hooks/health",
        attempts: 3,
        wait: async () => {
            waitCalls += 1;
        },
        fetchImpl: async (url) => {
            assert.equal(url, "https://shop.example.test/healthz");
            healthAttempts += 1;
            return healthAttempts < 3
                ? {
                    ok: false,
                    status: 503,
                    json: async () => ({ status: "failed", checks: { database: "failed" } }),
                }
                : {
                    ok: true,
                    status: 200,
                    json: async () => ({ status: "ok", checks: { database: "ok" } }),
                };
        },
    });

    assert.equal(payload.status, "ok");
    assert.equal(healthAttempts, 3);
    assert.equal(waitCalls, 2);
});

test("SQLite backup script writes a restorable backup file", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-backup-script-"));
    const databasePath = path.join(directory, "shop.db");
    const backupDir = path.join(directory, "backups");
    const db = new Database(databasePath);

    db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
    db.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");
    db.close();

    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const result = spawnSync(process.execPath, [
        path.join(rootDir, "scripts", "backup-sqlite.js"),
        `--database=${databasePath}`,
        `--out-dir=${backupDir}`,
    ], {
        cwd: rootDir,
        encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const backups = fs.readdirSync(backupDir).filter((fileName) => fileName.endsWith(".db"));
    assert.equal(backups.length, 1);
    assert.equal(fs.statSync(path.join(backupDir, backups[0])).mode & 0o777, 0o600);

    const backup = new Database(path.join(backupDir, backups[0]), { readonly: true });
    try {
        assert.deepEqual(backup.prepare("SELECT value FROM smoke").get(), { value: "ok" });
    } finally {
        backup.close();
    }
});

test("SQLite backup verification script restores and checks a backup copy", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-backup-verify-"));
    const databasePath = path.join(directory, "shop.db");
    const backupDir = path.join(directory, "backups");
    const db = new Database(databasePath);

    db.exec(`
        CREATE TABLE admins (id INTEGER PRIMARY KEY);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, order_number TEXT NOT NULL);
        CREATE TABLE products (id INTEGER PRIMARY KEY);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO orders (order_number) VALUES ('RCT-VERIFY');
    `);
    db.close();

    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const backupResult = spawnSync(process.execPath, [
        path.join(rootDir, "scripts", "backup-sqlite.js"),
        `--database=${databasePath}`,
        `--out-dir=${backupDir}`,
    ], {
        cwd: rootDir,
        encoding: "utf8",
    });
    assert.equal(backupResult.status, 0, backupResult.stderr || backupResult.stdout);

    const backupPath = path.join(backupDir, fs.readdirSync(backupDir).find((fileName) => fileName.endsWith(".db")));
    const verification = verifyBackup(backupPath);

    assert.ok(verification.schemaObjects > 0);
    assert.equal(verification.ordersTablePresent, true);
});

test("SQLite backup verification rejects an unrelated valid database", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-backup-invalid-"));
    const databasePath = path.join(directory, "unrelated.db");
    const db = new Database(databasePath);
    db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
    db.close();

    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    assert.throws(
        () => verifyBackup(databasePath),
        /not a complete shop database; missing tables/
    );
});
