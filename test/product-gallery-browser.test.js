const assert = require("node:assert/strict");
/* global document */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const { createApp } = require("../app");
const { createProduct } = require("../lib/db");

async function createGalleryTestServer(t) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-gallery-test-"));
    const app = createApp({
        rootDir: path.join(__dirname, ".."),
        databasePath: path.join(tempDir, "shop.db"),
        startBackgroundTasks: false,
        env: {
            ...process.env,
            NODE_ENV: "test",
            ADMIN_USERNAME: "admin",
            ADMIN_PASSWORD: "test-admin-password",
            SESSION_SECRET: "gallery-test-session-secret",
            ORDER_VIEW_TOKEN_SECRET: "gallery-test-order-secret",
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

function createGalleryProduct(db, overrides = {}) {
    return createProduct(db, {
        product_kind: "product",
        name: "Mobile Gallery Laptop",
        categories: "Tests",
        price_chf: "249.00",
        inventory: "2",
        image_url: "/static/images/missing-primary.jpg",
        image_gallery_urls: [
            "/static/images/recytech-logo.svg",
            "/static/images/illustrations/hero-workshop.jpg",
        ].join("\n"),
        short_description: "Product used to verify the responsive gallery.",
        description: "Gallery browser regression fixture.",
        published: "1",
        ...overrides,
    });
}

async function createMobilePage(t) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
    });
    const browserErrors = [];

    page.on("pageerror", (error) => browserErrors.push(error.message));
    t.after(() => browser.close());

    return { page, browserErrors };
}

test("mobile product gallery removes failed images, stays compact, and responds to swipe", async (t) => {
    const { baseUrl, db } = await createGalleryTestServer(t);
    const product = createGalleryProduct(db);
    const { page, browserErrors } = await createMobilePage(t);

    await page.goto(`${baseUrl}/products/${product.slug}`);
    await page.waitForFunction(() => document.querySelectorAll("[data-gallery-slide]").length === 2);

    assert.equal(await page.locator("[data-gallery-image]").count(), 2);
    assert.equal(await page.locator("[data-gallery-fallback]").isHidden(), true);

    const layout = await page.evaluate(() => {
        const title = document.querySelector(".product-detail > h1").getBoundingClientRect();
        const price = document.querySelector(".product-detail > .price-large").getBoundingClientRect();
        const main = document.querySelector(".product-gallery-main").getBoundingClientRect();
        const thumb = document.querySelector(".product-gallery-thumb").getBoundingClientRect();
        return {
            titleTop: title.top,
            priceTop: price.top,
            mainTop: main.top,
            mainHeight: main.height,
            thumbWidth: thumb.width,
            viewportWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
        };
    });

    assert.ok(layout.titleTop < layout.mainTop, "product title should precede the mobile gallery");
    assert.ok(layout.priceTop < layout.mainTop, "product price should precede the mobile gallery");
    assert.ok(layout.mainHeight <= 300, `expected a compact gallery, received ${layout.mainHeight}px`);
    assert.ok(layout.thumbWidth <= 70, `expected compact thumbnails, received ${layout.thumbWidth}px`);
    assert.equal(layout.scrollWidth, layout.viewportWidth);

    const viewport = page.locator("[data-gallery-viewport]");
    await viewport.dispatchEvent("pointerdown", {
        bubbles: true,
        clientX: 320,
        clientY: 140,
        isPrimary: true,
        pointerId: 1,
        pointerType: "touch",
    });
    await viewport.dispatchEvent("pointerup", {
        bubbles: true,
        clientX: 80,
        clientY: 145,
        isPrimary: true,
        pointerId: 1,
        pointerType: "touch",
    });

    assert.equal(await page.locator("[data-gallery-image].is-active").getAttribute("data-gallery-id"), "2");
    assert.deepEqual(browserErrors, []);
});

test("product gallery shows a branded fallback when every image fails", async (t) => {
    const { baseUrl, db } = await createGalleryTestServer(t);
    const product = createGalleryProduct(db, {
        name: "Gallery Fallback Laptop",
        image_gallery_urls: "/static/images/missing-secondary.jpg",
    });
    const { page, browserErrors } = await createMobilePage(t);

    await page.goto(`${baseUrl}/products/${product.slug}`);
    await page.locator("[data-gallery-fallback]").waitFor({ state: "visible" });

    assert.equal(await page.locator("[data-gallery-slide]").count(), 0);
    assert.equal(await page.locator("[data-gallery-image]").count(), 0);
    assert.match(await page.locator("[data-gallery-fallback]").innerText(), /Image indisponible/);
    assert.equal(await page.locator("[data-gallery-prev]").isHidden(), true);
    assert.equal(await page.locator("[data-gallery-next]").isHidden(), true);
    assert.deepEqual(browserErrors, []);
});
