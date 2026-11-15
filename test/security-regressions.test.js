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

function requestWithHost({ port, host, path: requestPath = "/", method = "GET", headers = {} }) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: "127.0.0.1",
            port,
            path: requestPath,
            method,
            headers: { ...headers, Host: host },
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

test("stateless health and product API probes do not create sessions", async (t) => {
    const { app, baseUrl } = await createTestServer(t);

    const health = await fetch(`${baseUrl}/healthz`);
    const products = await fetch(`${baseUrl}/api/products`);

    assert.equal(health.headers.get("set-cookie"), null);
    assert.equal(products.headers.get("set-cookie"), null);
    assert.equal(app.locals.runtime.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);

    const storefront = await fetch(`${baseUrl}/`);
    assert.ok(storefront.headers.get("set-cookie"));
    assert.equal(app.locals.runtime.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);
});

test("personalized HTML and private redirects cannot be stored by browsers or shared caches", async (t) => {
    const { baseUrl } = await createTestServer(t);
    for (const target of ["/", "/admin/login", "/admin/orders", "/checkout/success", "/cart", "/association-documents/committee"]) {
        const response = await fetch(`${baseUrl}${target}`, { redirect: "manual" });
        assert.equal(response.headers.get("cache-control"), "private, no-store", target);
    }
    const products = await fetch(`${baseUrl}/api/products`);
    assert.equal(products.headers.get("cache-control"), "public, max-age=120");
    const css = await fetch(`${baseUrl}/static/styles/main.css`);
    assert.match(css.headers.get("cache-control"), /public/);
});

test("production enforces HTTPS and does not trust forwarded headers when proxy trust is disabled", async (t) => {
    const { port } = await createTestServer(t, {
        NODE_ENV: "production",
        TRUST_PROXY: "false",
        SHOP_PUBLIC_URL: "https://shop.example.test",
        SESSION_SECRET: "security-test-session-secret-32-chars-minimum",
        ORDER_VIEW_TOKEN_SECRET: "security-test-order-view-secret-32-chars-minimum",
        ADMIN_PASSWORD: "test-admin-password-32-chars",
        SWISS_BITCOIN_PAY_WEBHOOK_SECRET: "",
    });
    const headers = { host: "shop.example.test", "x-forwarded-proto": "https" };
    const page = await requestWithHost({ port, host: "shop.example.test", path: "/admin/login", headers });
    assert.equal(page.statusCode, 308);
    assert.equal(page.headers.location, "https://shop.example.test/admin/login");
    assert.equal(page.headers["set-cookie"], undefined);
    const health = await requestWithHost({ port, host: "shop.example.test", path: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers["set-cookie"], undefined);
    const post = await requestWithHost({ port, host: "shop.example.test", path: "/admin/login", method: "POST", headers });
    assert.equal(post.statusCode, 400);
});

test("multipart forms cannot bypass the normal field-size boundary", async (t) => {
    const { app, baseUrl } = await createTestServer(t);
    const page = await fetch(`${baseUrl}/admin/login`);
    const csrf = (await page.text()).match(/name="csrf-token" content="([^"]+)"/)[1];
    const login = await fetch(`${baseUrl}/admin/login`, {
        method: "POST", redirect: "manual",
        headers: { cookie: page.headers.getSetCookie()[0].split(";")[0], "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: csrf, username: "admin", password: "test-admin-password" }),
    });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    const form = await fetch(`${baseUrl}/admin/products/new`, { headers: { cookie } });
    const formCsrf = (await form.text()).match(/name="csrf-token" content="([^"]+)"/)[1];
    const body = new FormData();
    for (const [name, value] of Object.entries({ _csrf: formCsrf, name: "Oversized product", categories: "Portables", price_chf: "100", inventory: "1", description: "x".repeat(200 * 1024) })) body.set(name, value);
    const result = await fetch(`${baseUrl}/admin/products/new`, { method: "POST", body, headers: { cookie }, redirect: "manual" });
    assert.equal(result.status, 302);
    assert.equal(result.headers.get("location"), "/admin/products/new");
    assert.equal(app.locals.runtime.db.prepare("SELECT COUNT(*) AS count FROM products").get().count, 0);
});


test("starting a new browser session cannot bypass Stripe intent creation limits", (t) => {
    const { createInfrastructureContext } = require("../lib/app-infrastructure-context");
    const context = createInfrastructureContext({
        rootDir: path.join(__dirname, ".."), databasePath: ":memory:", startBackgroundTasks: false,
        env: { NODE_ENV: "test", ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "security-test-admin-password" },
    });
    t.after(() => context.stop());
    for (let index = 0; index < 20; index++) {
        context.rateLimiters.registerStripeIntentAttempt({ ip: "192.0.2.1", sessionID: `session-${index}` });
    }
    assert.ok(context.rateLimiters.getStripeIntentRateLimitState({ ip: "192.0.2.1", sessionID: "new-session" }).blockedUntil > Date.now());
    assert.equal(context.rateLimiters.getStripeIntentRateLimitState({ ip: "192.0.2.2", sessionID: "new-session" }).blockedUntil, 0);
});
