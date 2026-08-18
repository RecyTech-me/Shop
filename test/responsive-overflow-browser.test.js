const assert = require("node:assert/strict");
/* global document */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const { createApp } = require("../app");
const { createProduct } = require("../lib/db");

async function createResponsiveTestServer(t) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-responsive-test-"));
    const app = createApp({
        rootDir: path.join(__dirname, ".."),
        databasePath: path.join(tempDir, "shop.db"),
        startBackgroundTasks: false,
        env: {
            ...process.env,
            NODE_ENV: "test",
            ADMIN_USERNAME: "admin",
            ADMIN_PASSWORD: "test-admin-password",
            SESSION_SECRET: "responsive-test-session-secret",
            ORDER_VIEW_TOKEN_SECRET: "responsive-test-order-secret",
            STRIPE_SECRET_KEY: "",
            STRIPE_PUBLISHABLE_KEY: "",
            SWISS_BITCOIN_PAY_API_KEY: "",
            SWISS_BITCOIN_PAY_WEBHOOK_SECRET: "",
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

    await new Promise((resolve) => server.once("listening", resolve));

    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        db: app.locals.runtime.db,
    };
}

async function measureOverflow(page) {
    await page.evaluate(() => {
        const sameOriginSheet = [...document.styleSheets].find((sheet) => sheet.href?.startsWith(document.location.origin));
        sameOriginSheet?.insertRule("html { overflow-y: scroll; scrollbar-gutter: stable; }", sameOriginSheet.cssRules.length);
    });

    return page.evaluate(() => {
        const navigation = document.querySelector(".site-nav")?.getBoundingClientRect();
        const headerShell = document.querySelector(".header-shell")?.getBoundingClientRect();
        return {
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            navigationWidth: navigation?.width || 0,
            headerShellWidth: headerShell?.width || 0,
        };
    });
}

function assertNoHorizontalOverflow(measurement, route, width) {
    assert.ok(
        measurement.scrollWidth <= measurement.clientWidth,
        `${route} overflowed horizontally at ${width}px (${measurement.scrollWidth}px > ${measurement.clientWidth}px)`
    );
    assert.ok(
        measurement.navigationWidth <= measurement.headerShellWidth + 0.5,
        `${route} mobile navigation escaped its shell at ${width}px`
    );
}

test("storefront purchase routes do not overflow common mobile widths", async (t) => {
    const { baseUrl, db } = await createResponsiveTestServer(t);
    const product = createProduct(db, {
        product_kind: "product",
        name: "Responsive Width Laptop",
        categories: "Tests",
        price_chf: "199.00",
        inventory: "3",
        image_url: "/static/images/recytech-logo.svg",
        short_description: "Product used by the responsive overflow regression test.",
        description: "Responsive overflow fixture.",
        published: "1",
    });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const routes = ["/", `/products/${product.slug}`, "/cart", "/checkout"];
    const widths = [320, 360, 375, 390, 430];

    t.after(() => browser.close());

    await page.goto(`${baseUrl}/products/${product.slug}`);
    await page.getByRole("button", { name: "Ajouter au panier" }).click();

    for (const width of widths) {
        await page.setViewportSize({ width, height: 844 });

        for (const route of routes) {
            await page.goto(`${baseUrl}${route}`);
            assertNoHorizontalOverflow(await measureOverflow(page), route, width);
        }
    }

    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`${baseUrl}/`);
    await page.getByRole("button", { name: "Ouvrir le menu" }).click();
    assertNoHorizontalOverflow(await measureOverflow(page), "open mobile navigation", 320);

    await page.locator(".catalogue-filter-more summary").click();
    assertNoHorizontalOverflow(await measureOverflow(page), "open advanced catalogue filters", 320);
});
