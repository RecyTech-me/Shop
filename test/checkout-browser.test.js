const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const { createApp } = require("../app");
const { createProduct, createPromoCode } = require("../lib/db");

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

    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto(`${baseUrl}/products/${product.slug}`);
    await page.getByRole("button", { name: "Ajouter au panier" }).click();
    const successNotice = page.locator(".flash-success");
    assert.equal(await successNotice.getAttribute("role"), "status");
    assert.equal(await successNotice.getAttribute("aria-live"), "polite");
    assert.equal(await successNotice.getByRole("link", { name: "Voir le panier" }).isVisible(), true);
    await successNotice.getByRole("button", { name: "Fermer le message" }).click();
    await successNotice.waitFor({ state: "hidden" });
    await page.goto(`${baseUrl}/cart`);
    const cartSummary = page.locator(".summary-card");
    assert.match(await textContent(cartSummary), /Retrait à Boudry Gratuit/);
    assert.match(await textContent(cartSummary), /Livraison La Poste \(tarif fixe\) 11[.,]50/);
    await page.getByRole("link", { name: "Passer au paiement" }).click();
    await page.waitForURL("**/checkout");

    const checkoutHeading = await page.locator(".checkout-page-heading").boundingBox();
    const checkoutSummary = page.locator("[data-checkout-summary]");
    const checkoutSummaryBox = await checkoutSummary.boundingBox();
    const checkoutFormBox = await page.locator(".checkout-form").boundingBox();
    assert.equal(await checkoutSummary.getAttribute("open"), null);
    assert.ok(checkoutHeading.y < checkoutSummaryBox.y);
    assert.ok(checkoutSummaryBox.y < checkoutFormBox.y);
    assert.equal(await page.locator("#checkout-order-total").isVisible(), true);
    await checkoutSummary.locator("summary").click();
    assert.notEqual(await checkoutSummary.getAttribute("open"), null);

    assert.match(await textContent(page.locator('label.delivery-card:has(input[value="ship"])')), /tarif fixe.*11[.,]50/);
    assert.match(await textContent(page.locator('label.delivery-card:has(input[value="pickup"])')), /Boudry.*Gratuit/);
    assert.equal(await page.locator('input[name="shipping_address1"]').getAttribute("required"), "");
    assert.equal(await page.locator('input[name="billing_address1"]').getAttribute("required"), null);

    const total = page.locator("#checkout-order-total");
    const checkoutSubmit = page.locator("[data-checkout-submit]");
    const paymentHelp = page.locator("[data-checkout-payment-help]");
    assert.match(await textContent(total), /111/);
    assert.equal(await textContent(checkoutSubmit), "Confirmer avec obligation de paiement");
    assert.match(await textContent(paymentHelp), /coordonnées bancaires.*virement/);
    assert.equal(await checkoutSubmit.getAttribute("data-label-card"), "Commander et payer par carte");
    assert.equal(await checkoutSubmit.getAttribute("data-label-bitcoin"), "Commander et payer en bitcoin");

    await page.locator('input[name="delivery_method"][value="pickup"]').check({ force: true });
    assert.equal(await page.locator('input[name="shipping_address1"]').getAttribute("required"), null);
    assert.equal(await page.locator('input[name="billing_address1"]').getAttribute("required"), "");
    await page.locator('input[name="payment_method"][value="cash"]').check({ force: true });
    assert.equal(await page.locator('input[name="payment_method"][value="cash"]').isChecked(), true);
    assert.match(await textContent(total), /90/);
    assert.equal(await page.locator("#checkout-payment-discount-row").isHidden(), false);
    assert.equal(await textContent(checkoutSubmit), "Confirmer avec obligation de paiement");
    assert.match(await textContent(paymentHelp), /espèces.*retrait à Boudry/);

    await page.locator('input[name="delivery_method"][value="ship"]').check({ force: true });
    assert.equal(await page.locator('input[name="payment_method"][value="cash"]').isDisabled(), true);
    assert.equal(await page.locator('input[name="payment_method"][value="transfer"]').isChecked(), true);
    assert.match(await textContent(page.locator("#checkout-shipping-price")), /11/);
    assert.match(await textContent(total), /111/);
    assert.match(await textContent(paymentHelp), /coordonnées bancaires.*virement/);

    await Promise.all([
        page.waitForNavigation(),
        page.locator(".checkout-form").evaluate((form) => form.submit()),
    ]);
    const errorSummary = page.locator("[data-checkout-error-summary]");
    const errorNotice = page.locator(".flash-error");
    assert.equal(await errorSummary.isVisible(), true);
    assert.equal(await errorSummary.evaluate((element) => element === element.ownerDocument.activeElement), true);
    assert.equal(await errorNotice.getAttribute("role"), "alert");
    assert.equal(await errorNotice.getAttribute("aria-live"), "assertive");
    await page.waitForTimeout(5200);
    assert.equal(await errorNotice.isVisible(), true);
    await errorNotice.getByRole("button", { name: "Fermer le message" }).click();
    await errorNotice.waitFor({ state: "hidden" });
    assert.match(await textContent(errorSummary), /Adresse de livraison.*Code postal de livraison.*Ville de livraison/);
    assert.equal(await page.locator("#checkout-shipping_address1").getAttribute("aria-invalid"), "true");
    assert.equal(await page.locator("#checkout-shipping_postal_code").getAttribute("aria-invalid"), "true");
    assert.equal(await page.locator("#checkout-shipping_city").getAttribute("aria-invalid"), "true");

    assert.deepEqual(browserErrors, []);
});

test("checkout browser applies and removes promo discount state", async (t) => {
    const { baseUrl, db } = await createBrowserTestServer(t);
    const product = createProduct(db, {
        product_kind: "product",
        name: "Promo Checkout Laptop",
        categories: "Tests",
        price_chf: "100.00",
        inventory: "3",
        short_description: "Promo checkout test product.",
        description: "Used by the Playwright promo checkout test.",
        published: "1",
    });
    createPromoCode(db, {
        code: "MERCI",
        discount_type: "percent",
        discount_value: 10,
        active: 1,
    });
    const browser = await chromium.launch({ headless: true });

    t.after(() => browser.close());

    const page = await browser.newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto(`${baseUrl}/products/${product.slug}`);
    await page.getByRole("button", { name: "Ajouter au panier" }).click();
    await page.goto(`${baseUrl}/checkout`);

    await page.locator('input[name="promo_code"]').fill("MERCI");
    await page.getByRole("button", { name: "Appliquer" }).click();
    await page.waitForLoadState("networkidle");

    assert.match(await textContent(page.locator(".promo-code-state-success")), /MERCI appliqué/);
    assert.equal(await page.locator("#checkout-promo-row").isHidden(), false);
    assert.match(await textContent(page.locator("#checkout-promo-amount")), /10/);
    assert.match(await textContent(page.locator("#checkout-order-total")), /101/);

    await page.locator('input[name="promo_code"]').fill("");
    await page.getByRole("button", { name: "Appliquer" }).click();
    await page.waitForLoadState("networkidle");

    assert.equal(await page.locator("#checkout-promo-row").isHidden(), true);
    assert.match(await textContent(page.locator("#checkout-order-total")), /111/);
    assert.deepEqual(browserErrors, []);
});
