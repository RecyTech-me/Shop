const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    createOrder,
    createProduct,
    createPromoCode,
    deleteOrder,
    deletePromoCode,
    getDashboardStats,
    getOrderById,
    getProductById,
    getPromoCodeById,
    initializeDatabase,
    listOrders,
    countOrders,
    markOrderPaid,
    reserveOrderInventory,
    updateOrderProviderReference,
    updateOrderStatus,
    updateOrderRecord,
} = require("../lib/db");

function createTestDb(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-shop-test-"));
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

test("markOrderPaid consumes inventory, service tags, and promo redemption once", (t) => {
    const db = createTestDb(t);
    const product = createProduct(db, {
        product_kind: "product",
        name: "ThinkPad inventory test",
        categories: "Ordinateurs",
        price_chf: "500.00",
        inventory: "3",
        published: "1",
        option_groups: "RAM: 16 GB",
        valid_configurations: "RAM=16 GB ; stock=2 ; tags=SER-1 | SER-2 => 500.00",
    });
    const promoCode = createPromoCode(db, {
        code: "MERCI",
        discount_type: "fixed",
        discount_value: 1000,
        active: true,
        max_redemptions: 5,
    });
    const order = createOrder(db, {
        provider: "transfer",
        customer_name: "Client Test",
        customer_email: "client@example.test",
        amount_cents: 99000,
        currency: "CHF",
        status: "pending",
        items: [{
            product_id: product.id,
            name: product.name,
            quantity: 2,
            unit_price_cents: 50000,
            line_total_cents: 100000,
            selected_options: [{ name: "RAM", value: "16 GB" }],
            service_tags: ["SER-2"],
        }],
        metadata: {
            promo: {
                id: promoCode.id,
                code: promoCode.code,
            },
        },
    });

    const paidOrder = markOrderPaid(db, order.id, {
        payment: {
            received_amount_cents: 100000,
        },
    });
    const paidProduct = getProductById(db, product.id);
    const paidPromoCode = getPromoCodeById(db, promoCode.id);

    assert.match(order.order_number, /^RCT-[A-F0-9]{16}$/);
    assert.equal(paidOrder.status, "paid");
    assert.deepEqual(paidOrder.items[0].service_tags.sort(), ["SER-1", "SER-2"]);
    assert.equal(paidOrder.metadata.payment.received_amount_cents, 100000);
    assert.equal(paidProduct.inventory, 1);
    assert.equal(paidProduct.valid_configurations[0].quantity, 0);
    assert.deepEqual(paidProduct.valid_configurations[0].service_tags, []);
    assert.equal(paidPromoCode.times_redeemed, 1);

    markOrderPaid(db, order.id);

    assert.equal(getProductById(db, product.id).inventory, 1);
    assert.equal(getPromoCodeById(db, promoCode.id).times_redeemed, 1);
    assert.equal(getOrderById(db, order.id).metadata.payment_recorded_at, paidOrder.metadata.payment_recorded_at);
    assert.equal(getOrderById(db, order.id).metadata.promo_redemption_redeemed_at, paidOrder.metadata.promo_redemption_redeemed_at);
});

test("external payment reservations hold stock and paid finalization does not double consume", (t) => {
    const db = createTestDb(t);
    const product = createProduct(db, {
        product_kind: "product",
        name: "Reserved payment laptop",
        categories: "Ordinateurs",
        price_chf: "500.00",
        inventory: "1",
        published: "1",
        option_groups: "RAM: 16 GB",
        valid_configurations: "RAM=16 GB ; stock=1 ; tags=RES-1 => 500.00",
    });
    const order = createOrder(db, {
        provider: "stripe",
        provider_reference: "pi_reserved",
        customer_name: "Reserved Customer",
        customer_email: "reserved@example.test",
        amount_cents: 50000,
        currency: "CHF",
        status: "pending",
        items: [{
            product_id: product.id,
            name: product.name,
            quantity: 1,
            unit_price_cents: 50000,
            line_total_cents: 50000,
            selected_options: [{ name: "RAM", value: "16 GB" }],
            service_tags: [],
        }],
        metadata: {},
    });

    const reservedOrder = reserveOrderInventory(db, order.id);
    const reservedProduct = getProductById(db, product.id);

    assert.equal(reservedProduct.inventory, 0);
    assert.equal(reservedProduct.valid_configurations[0].quantity, 0);
    assert.deepEqual(reservedProduct.valid_configurations[0].service_tags, []);
    assert.ok(reservedOrder.metadata.inventory_reserved_at);
    assert.deepEqual(reservedOrder.items[0].service_tags, ["RES-1"]);

    const paidOrder = markOrderPaid(db, order.id, {
        stripePaymentIntentId: "pi_reserved",
        paymentStatus: "succeeded",
    });
    const paidProduct = getProductById(db, product.id);

    assert.equal(paidOrder.status, "paid");
    assert.equal(paidProduct.inventory, 0);
    assert.equal(paidProduct.valid_configurations[0].quantity, 0);
    assert.equal(paidOrder.metadata.inventory_released_at, undefined);
});

test("inventory finalization rejects order items whose product no longer exists", (t) => {
    const db = createTestDb(t);
    const order = createOrder(db, {
        provider: "manual",
        customer_name: "Missing Product Customer",
        customer_email: "missing@example.test",
        amount_cents: 1000,
        currency: "CHF",
        status: "pending",
        items: [{
            product_id: 999999,
            name: "Deleted product",
            quantity: 1,
            unit_price_cents: 1000,
            line_total_cents: 1000,
            selected_options: [],
        }],
        metadata: {},
    });

    assert.throws(() => reserveOrderInventory(db, order.id), /Produit introuvable/);
    assert.equal(getOrderById(db, order.id).metadata.inventory_reserved_at, undefined);
});

test("paid finalization honors promo snapshot even after max redemptions are exhausted", (t) => {
    const db = createTestDb(t);
    const promoCode = createPromoCode(db, {
        code: "LIMITED",
        discount_type: "fixed",
        discount_value: 500,
        active: true,
        max_redemptions: 1,
    });
    const order = createOrder(db, {
        provider: "stripe",
        provider_reference: "pi_promo_snapshot",
        customer_name: "Promo Customer",
        customer_email: "promo@example.test",
        amount_cents: 9500,
        currency: "CHF",
        status: "pending",
        items: [],
        metadata: {
            promo: {
                id: promoCode.id,
                code: promoCode.code,
                discount_cents: 500,
            },
        },
    });

    db.prepare("UPDATE promo_codes SET times_redeemed = max_redemptions WHERE id = ?").run(promoCode.id);

    const paidOrder = markOrderPaid(db, order.id, {
        stripePaymentIntentId: "pi_promo_snapshot",
        paymentStatus: "succeeded",
    });

    assert.equal(paidOrder.status, "paid");
    assert.equal(getPromoCodeById(db, promoCode.id).times_redeemed, 1);
});

test("paid finalization survives a removed promo code and records the anomaly", (t) => {
    const db = createTestDb(t);
    const promoCode = createPromoCode(db, {
        code: "REMOVED",
        discount_type: "fixed",
        discount_value: 500,
        active: true,
    });
    const order = createOrder(db, {
        provider: "stripe",
        provider_reference: "pi_removed_promo",
        customer_name: "Promo Customer",
        customer_email: "promo@example.test",
        amount_cents: 9500,
        currency: "CHF",
        status: "pending",
        items: [],
        metadata: { promo: { id: promoCode.id, code: promoCode.code, discount_cents: 500 } },
    });

    deletePromoCode(db, promoCode.id);
    const paidOrder = markOrderPaid(db, order.id, { paymentStatus: "succeeded" });

    assert.equal(paidOrder.status, "paid");
    assert.ok(paidOrder.metadata.payment_recorded_at);
    assert.equal(paidOrder.metadata.promo_redemption_warning, "promo_code_missing");
});

test("promo redemption is reserved atomically and released with an unpaid order", (t) => {
    const db = createTestDb(t);
    const promoCode = createPromoCode(db, {
        code: "LASTONE",
        discount_type: "fixed",
        discount_value: 500,
        active: true,
        max_redemptions: 1,
    });
    const orderInput = {
        provider: "transfer",
        customer_name: "Promo Customer",
        customer_email: "promo@example.test",
        amount_cents: 9500,
        currency: "CHF",
        status: "pending",
        items: [],
        metadata: { promo: { id: promoCode.id, code: promoCode.code, discount_cents: 500 } },
    };

    const firstOrder = createOrder(db, orderInput);
    assert.ok(firstOrder.metadata.promo_redemption_reserved_at);
    assert.equal(getPromoCodeById(db, promoCode.id).times_redeemed, 1);
    assert.throws(() => createOrder(db, orderInput), /n'est plus disponible/);

    const failedOrder = updateOrderStatus(db, firstOrder.id, "failed");
    assert.ok(failedOrder.metadata.promo_redemption_released_at);
    assert.equal(getPromoCodeById(db, promoCode.id).times_redeemed, 0);

    const replacementOrder = createOrder(db, orderInput);
    const paidOrder = markOrderPaid(db, replacementOrder.id);
    assert.ok(paidOrder.metadata.promo_redemption_redeemed_at);
    assert.equal(getPromoCodeById(db, promoCode.id).times_redeemed, 1);
});

test("delayed payment events cannot regress a fulfilled paid order", (t) => {
    const db = createTestDb(t);
    const order = createOrder(db, {
        provider: "stripe",
        provider_reference: "pi_fulfilled",
        customer_name: "Fulfilled Customer",
        customer_email: "fulfilled@example.test",
        amount_cents: 25000,
        currency: "CHF",
        status: "pending",
        items: [],
        metadata: {},
    });

    const paidOrder = markOrderPaid(db, order.id, { paymentStatus: "succeeded" });
    updateOrderRecord(db, order.id, { status: "shipped" });
    markOrderPaid(db, order.id, { duplicatePaymentEvent: true });
    const afterFailure = updateOrderStatus(db, order.id, "failed", { paymentStatus: "canceled" });

    assert.equal(afterFailure.status, "shipped");
    assert.equal(afterFailure.metadata.payment_recorded_at, paidOrder.metadata.payment_recorded_at);
    assert.equal(afterFailure.metadata.duplicatePaymentEvent, true);
    assert.equal(afterFailure.metadata.paymentStatus, "canceled");
    assert.equal(getDashboardStats(db).revenueCents, 25000);
});

test("duplicate paid events cannot regress a refunded order", (t) => {
    const db = createTestDb(t);
    const order = createOrder(db, {
        provider: "stripe",
        provider_reference: "pi_refunded",
        customer_name: "Refunded Customer",
        customer_email: "refunded@example.test",
        amount_cents: 25000,
        currency: "CHF",
        status: "pending",
        items: [],
        metadata: {},
    });

    markOrderPaid(db, order.id, { paymentStatus: "succeeded" });
    updateOrderRecord(db, order.id, { status: "refunded" });
    const afterDuplicatePayment = markOrderPaid(db, order.id, { duplicatePaymentEvent: true });

    assert.equal(afterDuplicatePayment.status, "refunded");
    assert.equal(afterDuplicatePayment.metadata.duplicatePaymentEvent, true);
});

test("delayed pending provider events cannot reopen a failed order", (t) => {
    const db = createTestDb(t);
    const order = createOrder(db, {
        provider: "swissbitcoinpay",
        provider_reference: "invoice-terminal",
        customer_name: "Terminal Customer",
        customer_email: "terminal@example.test",
        amount_cents: 2500,
        currency: "CHF",
        status: "failed",
        items: [],
        metadata: {},
    });

    const afterPending = updateOrderStatus(db, order.id, "pending", {
        invoiceStatus: "pending",
    });

    assert.equal(afterPending.status, "failed");
    assert.equal(afterPending.metadata.invoiceStatus, "pending");
});

test("failed external payment reservations release stock for another checkout", (t) => {
    const db = createTestDb(t);
    const product = createProduct(db, {
        product_kind: "product",
        name: "Released reservation laptop",
        categories: "Ordinateurs",
        price_chf: "300.00",
        inventory: "1",
        published: "1",
        option_groups: "Grade: A",
        valid_configurations: "Grade=A ; stock=1 ; tags=REL-1 => 300.00",
    });
    const baseItem = {
        product_id: product.id,
        name: product.name,
        quantity: 1,
        unit_price_cents: 30000,
        line_total_cents: 30000,
        selected_options: [{ name: "Grade", value: "A" }],
        service_tags: [],
    };
    const firstOrder = createOrder(db, {
        provider: "stripe",
        provider_reference: "pi_first",
        customer_name: "First Customer",
        customer_email: "first@example.test",
        amount_cents: 30000,
        currency: "CHF",
        status: "pending",
        items: [baseItem],
        metadata: {},
    });

    reserveOrderInventory(db, firstOrder.id);

    const secondOrder = createOrder(db, {
        provider: "stripe",
        provider_reference: "pi_second",
        customer_name: "Second Customer",
        customer_email: "second@example.test",
        amount_cents: 30000,
        currency: "CHF",
        status: "pending",
        items: [baseItem],
        metadata: {},
    });

    assert.throws(() => reserveOrderInventory(db, secondOrder.id), /Stock insuffisant/);

    const failedOrder = updateOrderStatus(db, firstOrder.id, "failed", {
        paymentStatus: "requires_payment_method",
    });
    const releasedProduct = getProductById(db, product.id);

    assert.equal(failedOrder.status, "failed");
    assert.ok(failedOrder.metadata.inventory_released_at);
    assert.equal(releasedProduct.inventory, 1);
    assert.equal(releasedProduct.valid_configurations[0].quantity, 1);
    assert.deepEqual(releasedProduct.valid_configurations[0].service_tags, ["REL-1"]);

    const reservedSecondOrder = reserveOrderInventory(db, secondOrder.id);
    assert.ok(reservedSecondOrder.metadata.inventory_reserved_at);
    assert.equal(getProductById(db, product.id).inventory, 0);
});

test("orders with external payment or inventory history cannot be hard deleted", (t) => {
    const db = createTestDb(t);
    const order = createOrder(db, {
        provider: "stripe",
        provider_reference: "pi_preserved",
        customer_name: "Preserved Customer",
        customer_email: "preserved@example.test",
        amount_cents: 1000,
        currency: "CHF",
        status: "pending",
        items: [],
        metadata: {},
    });

    assert.throws(() => deleteOrder(db, order.id), /historique de paiement ou de stock/);
    assert.ok(getOrderById(db, order.id));
});

test("provider payment references are unique within each provider", (t) => {
    const db = createTestDb(t);
    const baseOrder = {
        provider_reference: "shared-reference",
        customer_name: "Reference Customer",
        customer_email: "reference@example.test",
        amount_cents: 1000,
        currency: "CHF",
        status: "pending",
        items: [],
        metadata: {},
    };

    createOrder(db, { ...baseOrder, provider: "stripe" });
    assert.throws(
        () => createOrder(db, { ...baseOrder, provider: "stripe" }),
        /UNIQUE constraint failed/
    );
    assert.doesNotThrow(() => createOrder(db, { ...baseOrder, provider: "swissbitcoinpay" }));
});

test("an assigned provider payment reference cannot be replaced", (t) => {
    const db = createTestDb(t);
    const order = createOrder(db, {
        provider: "swissbitcoinpay",
        customer_name: "Reference Customer",
        customer_email: "reference@example.test",
        amount_cents: 1000,
        currency: "CHF",
        status: "pending",
        items: [],
        metadata: {},
    });

    assert.equal(updateOrderProviderReference(db, order.id, "invoice-original").provider_reference, "invoice-original");
    assert.equal(updateOrderProviderReference(db, order.id, "invoice-original").provider_reference, "invoice-original");
    assert.throws(
        () => updateOrderProviderReference(db, order.id, "invoice-other"),
        /référence de paiement.*déjà définie/
    );
});

test("order listing applies pagination and count with filters", (t) => {
    const db = createTestDb(t);

    for (let index = 0; index < 55; index += 1) {
        createOrder(db, {
            provider: "transfer",
            customer_name: `Customer ${index}`,
            customer_email: `customer-${index}@example.test`,
            amount_cents: 1000 + index,
            currency: "CHF",
            status: index % 2 === 0 ? "pending" : "paid",
            items: [],
            metadata: {},
            created_at: `2026-06-23T10:${String(index).padStart(2, "0")}:00.000Z`,
        });
    }

    assert.equal(countOrders(db, { status: "pending" }), 28);
    assert.equal(listOrders(db, { limit: 10 }).length, 10);
    assert.equal(listOrders(db, { limit: 10, offset: 10 }).length, 10);
    assert.ok(listOrders(db, { query: "customer-54", limit: 10 })[0].customer_email.includes("customer-54"));
});
