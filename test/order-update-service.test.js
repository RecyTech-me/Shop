const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    createOrder,
    createProduct,
    getDashboardStats,
    getProductById,
    initializeDatabase,
    markOrderPaid,
    updateOrderRecord,
} = require("../lib/db");
const { normalizeText, normalizeOrderDateTimeField } = require("../lib/input-utils");
const {
    canEditOrderReceivedAmount,
    getOrderAdminData,
    getOrderPaymentData,
    readReceivedPaymentInput,
} = require("../lib/order-admin-helpers");
const { createOrderUpdateService } = require("../lib/order-update-service");

function createTestDb(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-order-update-test-"));
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

function createService(db) {
    return createOrderUpdateService({
        db,
        normalizeText,
        normalizeOrderDateTimeField,
        getOrderAdminData,
        canEditOrderReceivedAmount,
        readReceivedPaymentInput,
        getOrderPaymentData,
        markOrderPaid,
        updateOrderRecord,
    });
}

test("order update service can mark transfer orders paid and record received amount", (t) => {
    const db = createTestDb(t);
    const service = createService(db);
    const product = createProduct(db, {
        product_kind: "product",
        name: "Update service desktop",
        categories: "Ordinateurs",
        price_chf: "300.00",
        inventory: "2",
        published: "1",
    });
    const order = createOrder(db, {
        provider: "transfer",
        customer_name: "Update Customer",
        customer_email: "update@example.test",
        amount_cents: 30000,
        currency: "CHF",
        status: "awaiting_transfer",
        items: [{
            product_id: product.id,
            name: product.name,
            quantity: 1,
            unit_price_cents: 30000,
            line_total_cents: 30000,
            selected_options: [],
            service_tags: [],
        }],
        metadata: {
            admin: {
                internal_note: "Old note",
            },
        },
    });

    const updatedOrder = service.updateOrderFromInput(order, {
        status: "paid",
        order_created_at: "2026-06-23T12:30",
        actual_received_chf: "325.00",
        carrier: "La Poste",
        tracking_number: "TRACK-123",
        pickup_details: "",
        customer_note: "Thanks",
        fulfillment_note: "Packed",
        internal_note: "New note",
    });
    const updatedProduct = getProductById(db, product.id);
    const stats = getDashboardStats(db);

    assert.equal(updatedOrder.status, "paid");
    assert.equal(updatedOrder.metadata.payment.received_amount_cents, 32500);
    assert.equal(updatedOrder.metadata.admin.internal_note, "New note");
    assert.equal(updatedOrder.metadata.admin.tracking_number, "TRACK-123");
    assert.equal(updatedProduct.inventory, 1);
    assert.equal(stats.revenueCents, 32500);
});

test("order update service rejects unknown statuses before mutating", (t) => {
    const db = createTestDb(t);
    const service = createService(db);
    const order = createOrder(db, {
        provider: "manual",
        customer_name: "Invalid Status",
        customer_email: "",
        amount_cents: 1000,
        currency: "CHF",
        status: "pending",
        items: [],
        metadata: {},
    });

    assert.throws(() => {
        service.updateOrderFromInput(order, {
            status: "not-a-real-status",
            order_created_at: order.created_at,
        });
    }, /Statut de commande invalide/);
});

test("fulfillment transitions record payment and consume inventory", (t) => {
    const db = createTestDb(t);
    const service = createService(db);
    const product = createProduct(db, {
        product_kind: "product",
        name: "Fulfillment transition desktop",
        categories: "Ordinateurs",
        price_chf: "300.00",
        inventory: "2",
        published: "1",
    });
    const order = createOrder(db, {
        provider: "transfer",
        customer_name: "Fulfillment Customer",
        customer_email: "fulfillment@example.test",
        amount_cents: 30000,
        currency: "CHF",
        status: "awaiting_transfer",
        items: [{
            product_id: product.id,
            name: product.name,
            quantity: 1,
            unit_price_cents: 30000,
            line_total_cents: 30000,
            selected_options: [],
            service_tags: [],
        }],
        metadata: {},
    });

    const updatedOrder = service.updateOrderFromInput(order, {
        status: "processing",
        order_created_at: order.created_at,
    });

    assert.equal(updatedOrder.status, "processing");
    assert.ok(updatedOrder.metadata.payment_recorded_at);
    assert.equal(getProductById(db, product.id).inventory, 1);
    assert.equal(getDashboardStats(db).revenueCents, 30000);
});

test("paid orders cannot regress to unpaid admin statuses", (t) => {
    const db = createTestDb(t);
    const service = createService(db);
    const order = createOrder(db, {
        provider: "transfer",
        customer_name: "Paid Customer",
        customer_email: "paid@example.test",
        amount_cents: 30000,
        currency: "CHF",
        status: "paid",
        items: [],
        metadata: {
            payment_recorded_at: "2026-06-23T12:00:00.000Z",
        },
    });

    assert.throws(() => service.updateOrderFromInput(order, {
        status: "cancelled",
        order_created_at: order.created_at,
    }), /ne peut pas revenir à un statut non payé/);
    assert.equal(db.prepare("SELECT status FROM orders WHERE id = ?").get(order.id).status, "paid");
});

test("only paid orders can be marked refunded and refunds cannot be reopened", (t) => {
    const db = createTestDb(t);
    const service = createService(db);
    const unpaidOrder = createOrder(db, {
        provider: "transfer",
        customer_name: "Unpaid Customer",
        customer_email: "unpaid@example.test",
        amount_cents: 30000,
        currency: "CHF",
        status: "awaiting_transfer",
        items: [],
        metadata: {},
    });

    assert.throws(() => service.updateOrderFromInput(unpaidOrder, {
        status: "refunded",
        order_created_at: unpaidOrder.created_at,
    }), /non payée/);

    const paidOrder = markOrderPaid(db, unpaidOrder.id);
    const refundedOrder = service.updateOrderFromInput(paidOrder, {
        status: "refunded",
        order_created_at: paidOrder.created_at,
    });
    assert.equal(refundedOrder.status, "refunded");
    assert.throws(() => service.updateOrderFromInput(refundedOrder, {
        status: "paid",
        order_created_at: refundedOrder.created_at,
    }), /remboursée ne peut pas revenir/);
});
