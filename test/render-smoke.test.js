const assert = require("node:assert/strict");
const test = require("node:test");
const { app } = require("../app");

function listen(t) {
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise((resolve) => server.close(resolve)));

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
    assert.match(html, /<link rel="stylesheet" href="\/static\/styles\/main\.css">/);
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

        assert.equal(response.status, page.status, `${page.path} should return ${page.status}`);
        assertHtmlPage(text, page.title);
        assert.match(text, new RegExp(`<link rel="canonical" href="${baseUrl}${page.path === "/" ? "/" : page.path}">`));
    }

    const home = await fetchText(baseUrl, "/");
    const productMatch = home.text.match(/href="(\/products\/[^"]+)"/);
    if (productMatch) {
        const { response, text } = await fetchText(baseUrl, productMatch[1]);

        assert.equal(response.status, 200);
        assertHtmlPage(text, "[^<]+");
        assert.match(text, /<meta property="og:type" content="product">/);
    }

    const mainCss = await fetchText(baseUrl, "/static/styles/main.css");
    assert.equal(mainCss.response.status, 200);
    assert.doesNotMatch(mainCss.text, /footer-responsive/);

    const imports = [...mainCss.text.matchAll(/@import "\.\/([^"]+)";/g)].map((match) => match[1]);
    assert.ok(imports.includes("forms-tables.css"));
    assert.ok(imports.includes("footer.css"));
    assert.ok(imports.includes("responsive.css"));

    for (const fileName of imports) {
        const asset = await fetchText(baseUrl, `/static/styles/${fileName}`);

        assert.equal(asset.response.status, 200, `${fileName} should be served`);
        assert.ok(asset.text.trim().length > 0, `${fileName} should not be empty`);
    }
});
