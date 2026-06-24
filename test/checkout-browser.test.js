const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const { createApp } = require("../app");
const { createProduct } = require("../lib/db");

async function createBrowserTestServer(t) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-browser-test-"));
    const app = createApp({
        rootDir: path.join(__dirname, ".."),
        databasePath: path.join(tempDir, "shop.db"),
        startBackgroundTasks: false,
        env: {
            ...process.env,
            NODE_ENV: "test",
            ADMIN_USERNAME: "admin",
            ADMIN_PASSWORD: "test-admin-password",
            SESSION_SECRET: "browser-test-session-secret",
            ORDER_VIEW_TOKEN_SECRET: "browser-test-order-view-secret",
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

async function textContent(locator) {
    return String(await locator.textContent() || "").replace(/\s+/g, " ").trim();
}

test("checkout browser UI updates payment availability and totals", async (t) => {
    const { baseUrl, db } = await createBrowserTestServer(t);
    const product = createProduct(db, {
        product_kind: "product",
        name: "Browser Checkout Laptop",
        categories: "Tests",
        price_chf: "100.00",
        inventory: "3",
        short_description: "Browser checkout test product.",
        description: "Used by the Playwright checkout test.",
        published: "1",
    });
    const browser = await chromium.launch({ headless: true });

    t.after(() => browser.close());

    const page = await browser.newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto(`${baseUrl}/products/${product.slug}`);
    await page.getByRole("button", { name: "Ajouter au panier" }).click();
    await page.goto(`${baseUrl}/cart`);
    await page.getByRole("link", { name: "Passer au paiement" }).click();
    await page.waitForURL("**/checkout");

    const total = page.locator("#checkout-order-total");
    assert.match(await textContent(total), /111/);

    await page.locator('input[name="delivery_method"][value="pickup"]').check({ force: true });
    await page.locator('input[name="payment_method"][value="cash"]').check({ force: true });
    assert.equal(await page.locator('input[name="payment_method"][value="cash"]').isChecked(), true);
    assert.match(await textContent(total), /90/);
    assert.equal(await page.locator("#checkout-payment-discount-row").isHidden(), false);

    await page.locator('input[name="delivery_method"][value="ship"]').check({ force: true });
    assert.equal(await page.locator('input[name="payment_method"][value="cash"]').isDisabled(), true);
    assert.equal(await page.locator('input[name="payment_method"][value="transfer"]').isChecked(), true);
    assert.match(await textContent(page.locator("#checkout-shipping-price")), /11/);
    assert.match(await textContent(total), /111/);

    assert.deepEqual(browserErrors, []);
});
