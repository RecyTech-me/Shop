const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createOrder, getSalesAnalytics, initializeDatabase } = require("../lib/db");
const { readSalesAnalyticsFilters } = require("../lib/sales-analytics");

function createTestDb(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-analytics-test-"));
    const db = initializeDatabase(path.join(directory, "shop.db"), {
        NODE_ENV: "test",
        ADMIN_PASSWORD: "test-admin-password",
    });

    t.after(() => {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    return db;
}

function addOrder(db, overrides = {}) {
    return createOrder(db, {
        provider: "stripe",
        customer_name: "Client Analytics",
        customer_email: "analytics@example.test",
        amount_cents: 10000,
        currency: "CHF",
        status: "paid",
        items: [{
            product_id: 1,
            name: "Ordinateur A",
            quantity: 2,
            unit_price_cents: 5000,
            line_total_cents: 10000,
        }],
        metadata: {
            delivery: { method: "ship", label: "La Poste" },
        },
        created_at: "2026-08-10T10:00:00.000Z",
        ...overrides,
    });
}

test("analytics filters use Zurich calendar boundaries and reject oversized ranges", () => {
    const preset = readSalesAnalyticsFilters({}, new Date("2026-08-18T10:00:00.000Z"));
    assert.equal(preset.period, "30d");
    assert.equal(preset.from, "2026-07-20");
    assert.equal(preset.to, "2026-08-18");
    assert.equal(preset.previousFrom, "2026-06-20");
    assert.equal(preset.previousTo, "2026-07-19");

    const daylightSavingRange = readSalesAnalyticsFilters({
        period: "custom",
        from: "2026-03-29",
        to: "2026-03-30",
        provider: "stripe",
    });
    assert.equal(daylightSavingRange.startIso, "2026-03-28T23:00:00.000Z");
    assert.equal(daylightSavingRange.endExclusiveIso, "2026-03-30T22:00:00.000Z");
    assert.equal(daylightSavingRange.provider, "stripe");

    const invalid = readSalesAnalyticsFilters({
        period: "custom",
        from: "2025-01-01",
        to: "2026-08-18",
    }, new Date("2026-08-18T10:00:00.000Z"));
    assert.match(invalid.error, /limitée à 366 jours/);
    assert.equal(invalid.period, "30d");
});

test("sales analytics separate paid revenue, refunds, operations, and product performance", (t) => {
    const db = createTestDb(t);
    addOrder(db, {
        metadata: {
            delivery: { method: "ship", label: "La Poste" },
            promo: { code: "MERCI", discount_cents: 1000 },
        },
    });
    addOrder(db, {
        provider: "transfer",
        amount_cents: 5000,
        status: "completed",
        items: [{
            product_id: 2,
            name: "Écran B",
            quantity: 1,
            unit_price_cents: 5000,
            line_total_cents: 5000,
        }],
        metadata: {
            delivery: { method: "pickup", label: "Retrait" },
            payment: { received_amount_cents: 6000 },
        },
        created_at: "2026-08-12T10:00:00.000Z",
    });
    addOrder(db, {
        amount_cents: 3000,
        status: "refunded",
        items: [],
        created_at: "2026-08-13T10:00:00.000Z",
    });
    addOrder(db, {
        amount_cents: 4000,
        status: "pending",
        items: [],
        created_at: "2026-08-14T10:00:00.000Z",
    });
    const cancelled = addOrder(db, {
        amount_cents: 2000,
        status: "cancelled",
        items: [],
        created_at: "2026-08-15T10:00:00.000Z",
    });
    db.prepare("UPDATE orders SET items_json = ?, metadata_json = ? WHERE id = ?")
        .run("not-json", "[]", cancelled.id);
    addOrder(db, {
        provider: "cash",
        amount_cents: 8000,
        items: [{
            product_id: 3,
            name: "Ancienne vente",
            quantity: 1,
            unit_price_cents: 8000,
            line_total_cents: 8000,
        }],
        created_at: "2026-07-15T10:00:00.000Z",
    });

    const filters = readSalesAnalyticsFilters({
        period: "custom",
        from: "2026-08-01",
        to: "2026-08-31",
    });
    const analytics = getSalesAnalytics(db, filters);

    assert.deepEqual(analytics.summary, {
        totalOrders: 5,
        paidOrders: 2,
        pendingOrders: 1,
        refundedOrders: 1,
        cancelledOrders: 1,
        netRevenueCents: 16000,
        refundedCents: 3000,
        averageOrderCents: 8000,
        itemsSold: 3,
        discountsCents: 1000,
        promoOrders: 1,
    });
    assert.equal(analytics.comparisons.revenue, 100);
    assert.equal(analytics.comparisons.orders, 100);
    assert.deepEqual(analytics.providers.map((provider) => provider.key), ["stripe", "transfer"]);
    assert.equal(analytics.deliveryMethods.find((method) => method.key === "pickup").orders, 1);
    assert.equal(analytics.topProducts[0].name, "Ordinateur A");
    assert.equal(analytics.topProducts[0].quantity, 2);
    assert.equal(analytics.trend.buckets.length, 31);
    assert.equal(analytics.trend.buckets.find((bucket) => bucket.key === "2026-08-12").revenueCents, 6000);
});

test("provider filter scopes every metric and comparison", (t) => {
    const db = createTestDb(t);
    addOrder(db);
    addOrder(db, {
        provider: "transfer",
        amount_cents: 5000,
        created_at: "2026-08-11T10:00:00.000Z",
    });

    const filters = readSalesAnalyticsFilters({
        period: "custom",
        from: "2026-08-01",
        to: "2026-08-31",
        provider: "stripe",
    });
    const analytics = getSalesAnalytics(db, filters);

    assert.equal(analytics.summary.paidOrders, 1);
    assert.equal(analytics.summary.netRevenueCents, 10000);
    assert.deepEqual(analytics.providers.map((provider) => provider.key), ["stripe"]);
});
