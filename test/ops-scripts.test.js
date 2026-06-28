const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const Database = require("better-sqlite3");
const { parseCoverage } = require("../scripts/check-coverage");
const syntaxScript = require("../scripts/check-syntax");
const wordpressImportScript = require("../scripts/import-wordpress-shop");
const {
    buildAlertPayload,
    checkHealth,
    defaultHealthUrl,
    isHealthyPayload,
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

    const backup = new Database(path.join(backupDir, backups[0]), { readonly: true });
    try {
        assert.deepEqual(backup.prepare("SELECT value FROM smoke").get(), { value: "ok" });
    } finally {
        backup.close();
    }
});
