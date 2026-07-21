const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

async function importBrowserModule(relativePath) {
    const source = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
    return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("checkout browser summary calculates shipping, promo, and payment discount display state", async () => {
    const { calculateCheckoutSummary } = await importBrowserModule("public/scripts/checkout-calculations.js");

    const summary = calculateCheckoutSummary({
        selectedDelivery: "ship",
        selectedPayment: "bitcoin",
        pricePickupCents: "0",
        priceShipCents: "1150",
        subtotalCents: "10000",
        promoDiscountCents: "1500",
        promoLabel: "Code promo MERCI",
        paymentDiscountRate: "0.1",
    });

    assert.deepEqual(summary, {
        deliveryPriceCents: 1150,
        paymentDiscountCents: 850,
        paymentDiscountLabel: "Réduction Bitcoin (-10%)",
        paymentDiscountVisible: true,
        promoDiscountCents: 1500,
        promoLabel: "Code promo MERCI",
        promoVisible: true,
        totalCents: 8800,
    });
});

test("checkout browser summary hides discount rows when no discount applies", async () => {
    const { calculateCheckoutSummary } = await importBrowserModule("public/scripts/checkout-calculations.js");

    const summary = calculateCheckoutSummary({
        selectedDelivery: "pickup",
        selectedPayment: "transfer",
        pricePickupCents: "0",
        priceShipCents: "1150",
        subtotalCents: "10000",
        promoDiscountCents: "0",
        promoLabel: "",
        paymentDiscountRate: "0.1",
    });

    assert.equal(summary.deliveryPriceCents, 0);
    assert.equal(summary.paymentDiscountVisible, false);
    assert.equal(summary.promoVisible, false);
    assert.equal(summary.totalCents, 10000);
});

test("checkout draft flush waits for a pending session write before submission", async (t) => {
    const { createCheckoutDraftSaver } = await importBrowserModule("public/scripts/checkout-form-state.js");
    const originalFetch = global.fetch;
    const originalWindow = global.window;
    const pendingResponses = [];
    const requestBodies = [];

    t.after(() => {
        global.fetch = originalFetch;
        global.window = originalWindow;
    });

    global.window = {
        clearTimeout,
        setTimeout,
    };
    global.fetch = (_url, options) => {
        requestBodies.push(JSON.parse(options.body));
        return new Promise((resolve) => pendingResponses.push(resolve));
    };

    const field = { name: "customer_email", type: "email", value: "first@example.test" };
    const saver = createCheckoutDraftSaver({
        checkoutForm: {
            querySelectorAll: () => [field],
        },
        csrfToken: "csrf",
    });

    const firstSave = saver.persist();
    await Promise.resolve();
    const flush = saver.flush();
    await Promise.resolve();
    assert.deepEqual(requestBodies, [{ customer_email: "first@example.test" }]);

    pendingResponses.shift()({ ok: true });
    await firstSave;
    await flush;
    assert.deepEqual(requestBodies, [{ customer_email: "first@example.test" }]);
});
