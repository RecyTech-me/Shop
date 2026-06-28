const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const database = require("../lib/db");
const logger = require("../lib/logger");
const { createPaymentReservationCleanupService } = require("../lib/payment-reservation-cleanup-service");
const { mapSwissBitcoinPayStatus } = require("../lib/payments/swiss-bitcoin-pay");

logger.configureLogger({ level: "silent" });

const NOW_MS = Date.parse("2026-06-28T12:00:00.000Z");
const OLD_RESERVATION_AT = "2026-06-28T10:00:00.000Z";
const FRESH_RESERVATION_AT = "2026-06-28T11:30:00.000Z";

function createTestDb(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-reservation-cleanup-"));
    const db = database.initializeDatabase(path.join(directory, "shop.db"), {
        NODE_ENV: "test",
        ADMIN_PASSWORD: "test-admin-password",
    });

    t.after(() => {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    return db;
}

function setOrderReservationAt(db, orderId, reservedAt) {
    const order = database.getOrderById(db, orderId);
    db.prepare("UPDATE orders SET metadata_json = ? WHERE id = ?").run(JSON.stringify({
        ...order.metadata,
        inventory_reserved_at: reservedAt,
    }), orderId);
}

function createReservedOrder(db, options = {}) {
    const product = database.createProduct(db, {
        product_kind: "product",
        name: options.productName || "Cleanup reservation laptop",
        categories: "Tests",
        price_chf: "400.00",
        inventory: "1",
        published: "1",
        option_groups: "Grade: A",
        valid_configurations: "Grade=A ; stock=1 ; tags=CLEAN-1 => 400.00",
    });
    const order = database.createOrder(db, {
        provider: options.provider || "stripe",
        provider_reference: options.providerReference || "pi_cleanup",
        customer_name: "Cleanup Customer",
        customer_email: "cleanup@example.test",
        amount_cents: 40000,
        currency: "CHF",
        status: "pending",
        items: [{
            product_id: product.id,
            name: product.name,
            quantity: 1,
            unit_price_cents: 40000,
            line_total_cents: 40000,
            selected_options: [{ name: "Grade", value: "A" }],
            service_tags: [],
        }],
        metadata: options.metadata || {},
    });

    const reservedOrder = database.reserveOrderInventory(db, order.id);
    setOrderReservationAt(db, order.id, options.reservedAt || OLD_RESERVATION_AT);

    return {
        order: database.getOrderById(db, reservedOrder.id),
        product,
    };
}

function createCleanupService(db, overrides = {}) {
    return createPaymentReservationCleanupService({
        db,
        orders: database,
        stripe: overrides.stripe || null,
        swissBitcoinPay: overrides.swissBitcoinPay || null,
        mapSwissBitcoinPayStatus,
        ttlMs: 60 * 60 * 1000,
        limit: overrides.limit || 25,
        now: () => NOW_MS,
    });
}

test("stale Stripe reservations cancel abandoned PaymentIntents and release stock", async (t) => {
    const db = createTestDb(t);
    const { order, product } = createReservedOrder(db, {
        providerReference: "pi_abandoned",
    });
    const calls = [];
    const service = createCleanupService(db, {
        stripe: {
            paymentIntents: {
                retrieve: async (id) => {
                    calls.push(["retrieve", id]);
                    return { id, status: "requires_payment_method" };
                },
                cancel: async (id, input) => {
                    calls.push(["cancel", id, input]);
                    return { id, status: "canceled" };
                },
            },
        },
    });

    const summary = await service.cleanupStaleReservations();
    const cleanedOrder = database.getOrderById(db, order.id);
    const cleanedProduct = database.getProductById(db, product.id);

    assert.deepEqual(summary, {
        checked: 1,
        paid: 0,
        released: 1,
        kept: 0,
        skipped: 0,
        failed: 0,
    });
    assert.deepEqual(calls, [
        ["retrieve", "pi_abandoned"],
        ["cancel", "pi_abandoned", { cancellation_reason: "abandoned" }],
    ]);
    assert.equal(cleanedOrder.status, "failed");
    assert.equal(cleanedOrder.metadata.paymentStatus, "canceled");
    assert.ok(cleanedOrder.metadata.inventory_released_at);
    assert.equal(cleanedProduct.inventory, 1);
    assert.equal(cleanedProduct.valid_configurations[0].quantity, 1);
    assert.deepEqual(cleanedProduct.valid_configurations[0].service_tags, ["CLEAN-1"]);
});

test("fresh external reservations are not reconciled before the TTL", async (t) => {
    const db = createTestDb(t);
    const { product } = createReservedOrder(db, {
        providerReference: "pi_fresh",
        reservedAt: FRESH_RESERVATION_AT,
    });
    const service = createCleanupService(db, {
        stripe: {
            paymentIntents: {
                retrieve: async () => {
                    throw new Error("should not retrieve fresh reservations");
                },
            },
        },
    });

    const summary = await service.cleanupStaleReservations();

    assert.equal(summary.checked, 0);
    assert.equal(database.getProductById(db, product.id).inventory, 0);
});

test("stale Stripe reservations are marked paid when the PaymentIntent succeeded", async (t) => {
    const db = createTestDb(t);
    const { order, product } = createReservedOrder(db, {
        providerReference: "pi_paid",
    });
    const service = createCleanupService(db, {
        stripe: {
            paymentIntents: {
                retrieve: async (id) => ({ id, status: "succeeded" }),
            },
        },
    });

    const summary = await service.cleanupStaleReservations();
    const paidOrder = database.getOrderById(db, order.id);

    assert.equal(summary.checked, 1);
    assert.equal(summary.paid, 1);
    assert.equal(paidOrder.status, "paid");
    assert.equal(paidOrder.metadata.paymentStatus, "succeeded");
    assert.ok(paidOrder.metadata.payment_recorded_at);
    assert.equal(database.getProductById(db, product.id).inventory, 0);
});

test("stale Swiss Bitcoin Pay expired invoices release reserved stock", async (t) => {
    const db = createTestDb(t);
    const { order, product } = createReservedOrder(db, {
        provider: "swissbitcoinpay",
        providerReference: "invoice-expired",
    });
    const service = createCleanupService(db, {
        swissBitcoinPay: {
            fetchInvoice: async (invoiceId) => ({
                id: invoiceId,
                status: "expired",
                isExpired: true,
            }),
        },
    });

    const summary = await service.cleanupStaleReservations();
    const cleanedOrder = database.getOrderById(db, order.id);

    assert.equal(summary.checked, 1);
    assert.equal(summary.released, 1);
    assert.equal(cleanedOrder.status, "failed");
    assert.equal(cleanedOrder.metadata.invoiceStatus, "expired");
    assert.ok(cleanedOrder.metadata.inventory_released_at);
    assert.equal(database.getProductById(db, product.id).inventory, 1);
});

test("Stripe retrieve failures increment failed and keep reserved stock", async (t) => {
    const db = createTestDb(t);
    const { order, product } = createReservedOrder(db, {
        providerReference: "pi_retrieve_down",
    });
    const service = createCleanupService(db, {
        stripe: {
            paymentIntents: {
                retrieve: async () => {
                    throw new Error("stripe outage");
                },
            },
        },
    });

    const summary = await service.cleanupStaleReservations();
    const keptOrder = database.getOrderById(db, order.id);

    assert.equal(summary.failed, 1);
    assert.equal(keptOrder.status, "pending");
    assert.equal(keptOrder.metadata.inventory_released_at, undefined);
    assert.equal(database.getProductById(db, product.id).inventory, 0);
});

test("Stripe cancel failures increment failed and keep reservation", async (t) => {
    const db = createTestDb(t);
    const { order, product } = createReservedOrder(db, {
        providerReference: "pi_cancel_down",
    });
    const service = createCleanupService(db, {
        stripe: {
            paymentIntents: {
                retrieve: async (id) => ({ id, status: "requires_payment_method" }),
                cancel: async () => {
                    throw new Error("cancel unavailable");
                },
            },
        },
    });

    const summary = await service.cleanupStaleReservations();
    const keptOrder = database.getOrderById(db, order.id);

    assert.equal(summary.failed, 1);
    assert.equal(keptOrder.status, "pending");
    assert.equal(keptOrder.metadata.inventory_released_at, undefined);
    assert.equal(database.getProductById(db, product.id).inventory, 0);
});

test("Swiss Bitcoin Pay fetch failures increment failed and keep reservation", async (t) => {
    const db = createTestDb(t);
    const { order, product } = createReservedOrder(db, {
        provider: "swissbitcoinpay",
        providerReference: "invoice-fetch-down",
    });
    const service = createCleanupService(db, {
        swissBitcoinPay: {
            fetchInvoice: async () => {
                throw new Error("invoice fetch unavailable");
            },
        },
    });

    const summary = await service.cleanupStaleReservations();
    const keptOrder = database.getOrderById(db, order.id);

    assert.equal(summary.failed, 1);
    assert.equal(keptOrder.status, "pending");
    assert.equal(keptOrder.metadata.inventory_released_at, undefined);
    assert.equal(database.getProductById(db, product.id).inventory, 0);
});

test("stale reservation cleanup respects the configured processing limit", async (t) => {
    const db = createTestDb(t);
    createReservedOrder(db, { providerReference: "pi_limit_1", productName: "Limit cleanup 1" });
    createReservedOrder(db, { providerReference: "pi_limit_2", productName: "Limit cleanup 2" });
    createReservedOrder(db, { providerReference: "pi_limit_3", productName: "Limit cleanup 3" });
    const retrieved = [];
    const service = createCleanupService(db, {
        limit: 2,
        stripe: {
            paymentIntents: {
                retrieve: async (id) => {
                    retrieved.push(id);
                    return { id, status: "canceled" };
                },
            },
        },
    });

    const summary = await service.cleanupStaleReservations();

    assert.equal(summary.checked, 2);
    assert.equal(summary.released, 2);
    assert.equal(retrieved.length, 2);
});

test("stale reservation cleanup logs complete summary counters", async (t) => {
    const originalInfo = logger.info;
    const logged = [];
    logger.info = (...args) => logged.push(args);
    t.after(() => {
        logger.info = originalInfo;
    });

    const db = createTestDb(t);
    createReservedOrder(db, {
        providerReference: "pi_logged_cleanup",
    });
    const service = createCleanupService(db, {
        stripe: {
            paymentIntents: {
                retrieve: async (id) => ({ id, status: "canceled" }),
            },
        },
    });

    await service.cleanupStaleReservations();

    const summaryLog = logged.find((entry) => entry[0] === "payments.reservation_cleanup");
    assert.ok(summaryLog, "Expected cleanup summary log");
    assert.deepEqual(Object.keys(summaryLog[1]).sort(), [
        "checked",
        "failed",
        "kept",
        "paid",
        "released",
        "skipped",
    ]);
    assert.equal(summaryLog[1].checked, 1);
    assert.equal(summaryLog[1].released, 1);
});
