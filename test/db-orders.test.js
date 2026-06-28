const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    createOrder,
    createProduct,
    createPromoCode,
    getOrderById,
    getProductById,
    getPromoCodeById,
    initializeDatabase,
    listOrders,
    countOrders,
    markOrderPaid,
    reserveOrderInventory,
    updateOrderStatus,
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
    assert.equal(getPromoCodeById(db, promoCode.id).times_redeemed, 2);
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
