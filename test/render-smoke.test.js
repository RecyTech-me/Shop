const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp } = require("../app");

function listen(t) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-render-smoke-"));
    const app = createApp({
        rootDir: path.join(__dirname, ".."),
        databasePath: path.join(tempDir, "shop.db"),
        startBackgroundTasks: false,
        env: {
            ...process.env,
            NODE_ENV: "test",
            ADMIN_USERNAME: "admin",
            ADMIN_PASSWORD: "test-admin-password",
            SESSION_SECRET: "render-smoke-session-secret",
            ORDER_VIEW_TOKEN_SECRET: "render-smoke-order-view-secret",
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
            const { port } = server.address();
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

async function fetchText(baseUrl, path) {
    const response = await fetch(`${baseUrl}${path}`);
    const text = await response.text();

    return { response, text };
}

function assertHtmlPage(html, titlePrefix) {
    assert.match(html, new RegExp(`<title>${titlePrefix} \\| [^<]+</title>`));
    assert.match(html, /<meta name="csrf-token" content="[a-f0-9]+">/);
    assert.match(html, /<link rel="stylesheet" href="\/static\/styles\/main\.css\?v=[a-z0-9]+">/);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("critical pages render with SEO metadata and static CSS assets", async (t) => {
    const baseUrl = await listen(t);
    const pages = [
        { path: "/", status: 200, title: "Boutique RecyTech" },
        { path: "/cart", status: 200, title: "Panier" },
        { path: "/admin/login", status: 200, title: "Connexion" },
        { path: "/conditions-generales-de-vente", status: 200, title: "Conditions générales de vente" },
        { path: "/missing-page-smoke-test", status: 404, title: "Page introuvable" },
    ];

    for (const page of pages) {
        const { response, text } = await fetchText(baseUrl, page.path);
        const csp = response.headers.get("content-security-policy") || "";
        const requestId = response.headers.get("x-request-id") || "";

        assert.equal(response.status, page.status, `${page.path} should return ${page.status}`);
        assert.match(requestId, /^[a-zA-Z0-9._:-]{8,128}$/);
        assert.match(csp, /default-src 'self'/);
        assert.match(csp, /script-src 'self' 'nonce-[^']+' https:\/\/js\.stripe\.com/);
        assert.doesNotMatch(csp, /unsafe-inline/);
        const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
        assert.ok(nonce, "Expected CSP to include a script nonce");
        assertHtmlPage(text, page.title);
        assert.match(text, new RegExp(`<script nonce="${escapeRegExp(nonce)}"`));
        assert.match(text, new RegExp(`<link rel="canonical" href="${baseUrl}${page.path === "/" ? "/" : page.path}">`));
    }

    const home = await fetchText(baseUrl, "/");
    const stylesheetMatch = home.text.match(/<link rel="stylesheet" href="([^"]+)">/);
    assert.ok(stylesheetMatch, "Expected a versioned stylesheet URL");
    assert.match(stylesheetMatch[1], /^\/static\/styles\/main\.css\?v=[a-z0-9]+$/);

    const versionedMainCss = await fetchText(baseUrl, stylesheetMatch[1]);
    assert.equal(versionedMainCss.response.status, 200);
    assert.match(versionedMainCss.response.headers.get("cache-control") || "", /immutable/);

    const productMatch = home.text.match(/href="(\/products\/[^"]+)"/);
    if (productMatch) {
        const { response, text } = await fetchText(baseUrl, productMatch[1]);

        assert.equal(response.status, 200);
        assertHtmlPage(text, "[^<]+");
        assert.match(text, /<meta property="og:type" content="product">/);
    }

    const mainCss = await fetchText(baseUrl, "/static/styles/main.css");
    assert.equal(mainCss.response.status, 200);
    assert.doesNotMatch(mainCss.response.headers.get("cache-control") || "", /immutable/);
    assert.doesNotMatch(mainCss.text, /footer-responsive/);

    const imports = [...mainCss.text.matchAll(/@import "\.\/([^"]+)";/g)].map((match) => match[1]);
    assert.ok(imports.includes("forms-tables.css"));
    assert.ok(imports.includes("footer.css"));
    assert.ok(imports.includes("responsive.css"));

    for (const fileName of imports) {
        const asset = await fetchText(baseUrl, `/static/styles/${fileName}`);

        assert.equal(asset.response.status, 200, `${fileName} should be served`);
        assert.ok(asset.text.trim().length > 0, `${fileName} should not be empty`);

        const nestedImports = [...asset.text.matchAll(/@import "\.\/([^"]+)";/g)].map((match) => match[1]);
        for (const nestedFileName of nestedImports) {
            const nestedAsset = await fetchText(baseUrl, `/static/styles/${nestedFileName}`);

            assert.equal(nestedAsset.response.status, 200, `${nestedFileName} should be served`);
            assert.ok(nestedAsset.text.trim().length > 0, `${nestedFileName} should not be empty`);
        }
    }

    const health = await fetchText(baseUrl, "/healthz");
    const healthJson = JSON.parse(health.text);
    assert.equal(health.response.status, 200);
    assert.equal(health.response.headers.get("content-type")?.includes("application/json"), true);
    assert.match(health.response.headers.get("cache-control") || "", /no-store/);
    assert.match(health.response.headers.get("x-request-id") || "", /^[a-zA-Z0-9._:-]{8,128}$/);
    assert.deepEqual(healthJson.checks, { database: "ok" });
    assert.equal(healthJson.status, "ok");
});
