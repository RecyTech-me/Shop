const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp } = require("../app");
const logger = require("../lib/logger");

logger.configureLogger({ level: "silent" });

function createTestServer(t, envOverrides = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-security-"));
    const app = createApp({
        rootDir: path.join(__dirname, ".."),
        databasePath: path.join(tempDir, "shop.db"),
        startBackgroundTasks: false,
        env: {
            ...process.env,
            NODE_ENV: "test",
            ADMIN_USERNAME: "admin",
            ADMIN_PASSWORD: "test-admin-password",
            SESSION_SECRET: "security-test-session-secret",
            ORDER_VIEW_TOKEN_SECRET: "security-test-order-view-secret",
            STRIPE_SECRET_KEY: "",
            STRIPE_PUBLISHABLE_KEY: "",
            SWISS_BITCOIN_PAY_API_KEY: "",
            SWISS_BITCOIN_PAY_WEBHOOK_SECRET: "test-webhook-secret",
            ...envOverrides,
            LOG_LEVEL: "silent",
        },
    });
    const server = app.listen(0, "127.0.0.1");

    t.after(() => new Promise((resolve) => {
        server.close(() => {
            app.locals.runtime?.stop();
            fs.rmSync(tempDir, { recursive: true, force: true });
            resolve();
        });
    }));

    return new Promise((resolve) => {
        server.once("listening", () => {
            resolve({
                app,
                baseUrl: `http://127.0.0.1:${server.address().port}`,
                port: server.address().port,
            });
        });
    });
}

function requestWithHost({ port, host, path: requestPath = "/" }) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: "127.0.0.1",
            port,
            path: requestPath,
            method: "GET",
            headers: { Host: host },
        }, (response) => {
            response.resume();
            response.on("end", () => resolve(response));
        });
        request.on("error", reject);
        request.end();
    });
}

test("CSRF rejects mutating non-webhook requests", async (t) => {
    const { baseUrl } = await createTestServer(t);
    const response = await fetch(`${baseUrl}/cart/remove`, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
        },
        redirect: "manual",
        body: new URLSearchParams({ item_key: "missing" }),
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/");
});

test("webhooks bypass CSRF but still require provider verification", async (t) => {
    const { baseUrl } = await createTestServer(t);
    const response = await fetch(`${baseUrl}/webhooks/swiss-bitcoin-pay`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ id: "invoice-1" }),
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.error, "Invalid webhook secret");
});

test("production host validation rejects invalid Host headers", async (t) => {
    const { port } = await createTestServer(t, {
        NODE_ENV: "production",
        SHOP_PUBLIC_URL: "https://shop.example.test",
        BASE_URL: "https://shop.example.test",
        SESSION_SECRET: "security-test-session-secret-32-chars-minimum",
        ORDER_VIEW_TOKEN_SECRET: "security-test-order-view-secret-32-chars-minimum",
        ADMIN_PASSWORD: "test-admin-password-32-chars",
        SWISS_BITCOIN_PAY_WEBHOOK_SECRET: "",
    });

    const rejected = await requestWithHost({
        port,
        host: "evil.example.test",
    });
    const accepted = await requestWithHost({
        port,
        host: "shop.example.test",
    });

    assert.equal(rejected.statusCode, 400);
    assert.notEqual(accepted.statusCode, 400);
});

test("CSP allows Stripe scripts without unsafe-inline", async (t) => {
    const { baseUrl } = await createTestServer(t);
    const response = await fetch(`${baseUrl}/`);
    const csp = response.headers.get("content-security-policy") || "";

    assert.equal(response.status, 200);
    assert.match(csp, /https:\/\/js\.stripe\.com/);
    assert.doesNotMatch(csp, /unsafe-inline/);
});
