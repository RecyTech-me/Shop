const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp } = require("../app");
const { getDocumentReturnTarget } = require("../routes/association-documents");

const committee = "/association-documents/committee";
const assembly = "/association-documents/general-meeting";
const pdf = `${committee}/pv-comit%C3%A9-04.04.2025.pdf`;

async function setup(t) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-documents-"));
    const documentsDir = path.join(tempDir, "documents");
    for (const file of ["committee/pv-comité-04.04.2025.pdf", "general-meeting/pv-ag-constitutive.pdf"]) {
        const destination = path.join(documentsDir, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, "%PDF-1.4\nSynthetic test fixture only.\n");
    }
    const app = createApp({
        rootDir: path.join(__dirname, ".."),
        databasePath: path.join(tempDir, "shop.db"),
        startBackgroundTasks: false,
        env: {
            ...process.env,
            NODE_ENV: "test",
            ASSOCIATION_DOCUMENTS_PATH: documentsDir,
            ADMIN_USERNAME: "admin",
            ADMIN_PASSWORD: "test-admin-password",
            SESSION_SECRET: "documents-test-session-secret",
            ORDER_VIEW_TOKEN_SECRET: "documents-test-order-secret",
        },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        app.locals.runtime.stop();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    let cookie = "";
    let csrf = "";
    async function request(target, values) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${target}`, {
            redirect: "manual",
            headers: {
                cookie,
                ...(values ? { "content-type": "application/x-www-form-urlencoded" } : {}),
            },
            ...(values ? { method: "POST", body: new URLSearchParams({ _csrf: csrf, ...values }) } : {}),
        });
        for (const entry of response.headers.getSetCookie()) cookie = entry.split(";")[0];
        const body = Buffer.from(await response.arrayBuffer());
        const token = body.toString().match(/name="csrf-token" content="([^"]+)"/);
        if (token) csrf = token[1];
        return { response, body, location: response.headers.get("location") };
    }
    async function login(password = "test-admin-password") {
        await request("/admin/login");
        return request("/admin/login", { username: "admin", password });
    }
    return { app, request, login };
}

test("all private pages and direct PDFs require the existing shop account", async (t) => {
    const { request, login } = await setup(t);
    for (const target of [committee, assembly, pdf, `${assembly}/pv-ag-constitutive.pdf`]) {
        const result = await request(target);
        assert.equal(result.response.status, 302);
        assert.equal(result.location, "/admin/login");
        assert.equal(result.response.headers.get("cache-control"), "private, no-store");
        assert.ok(!result.body.subarray(0, 4).equals(Buffer.from("%PDF")));
    }
    await request(pdf);
    const failed = await login("wrong-password");
    assert.equal(failed.location, "/admin/login");
    const loginPage = await request("/admin/login");
    assert.match(loginPage.body.toString(), /compte du shop/);
    const success = await login();
    assert.equal(success.location, pdf);
    const document = await request(pdf);
    assert.equal(document.response.status, 200);
    assert.match(document.response.headers.get("content-type"), /application\/pdf/);
    assert.equal(document.body.subarray(0, 5).toString(), "%PDF-");
    assert.equal(document.response.headers.get("cache-control"), "private, no-store");
    assert.equal(document.response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    for (const target of [committee, assembly]) {
        const listing = await request(target);
        assert.equal(listing.response.status, 200);
        assert.match(listing.body.toString(), /Statuts \(publics\)/);
        assert.match(listing.body.toString(), /noindex,nofollow/);
    }
    assert.equal((await request(`${assembly}/pv-ag-constitutive.pdf`)).response.status, 200);
    for (const target of [`${committee}/shop.db`, `${committee}/%2e%2e%2f%2e%2e%2f.env`, "/static/association-documents/committee/pv-comit%C3%A9-04.04.2025.pdf", "/private/association-documents/committee/pv-comit%C3%A9-04.04.2025.pdf"]) {
        assert.equal((await request(target)).response.status, 404);
    }
    await request("/admin/logout", {});
    assert.equal((await request(pdf)).location, "/admin/login");
});

test("account changes revoke document access through the same auth version", async (t) => {
    const { app, request, login } = await setup(t);
    await request(assembly);
    assert.equal((await login()).location, assembly);
    app.locals.runtime.db.prepare("UPDATE admins SET auth_version = auth_version + 1 WHERE username = ?").run("admin");
    assert.equal((await request(pdf)).location, "/admin/login");
});

test("document return targets cannot redirect to arbitrary URLs or files", () => {
    assert.equal(getDocumentReturnTarget(pdf), pdf);
    assert.equal(getDocumentReturnTarget(pdf.replace("%C3%A9", "%c3%a9")), pdf);
    assert.equal(getDocumentReturnTarget("/association-documents/committee/%broken"), null);
    assert.equal(getDocumentReturnTarget(assembly), assembly);
    for (const target of [undefined, "https://evil.example", "//evil.example", `${committee}/../../.env`, `${committee}?next=https://evil.example`, "/admin", `${committee}/unknown.pdf`]) {
        assert.equal(getDocumentReturnTarget(target), null);
    }
});

