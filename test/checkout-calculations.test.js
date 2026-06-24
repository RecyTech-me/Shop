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
