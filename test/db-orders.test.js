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
    markOrderPaid,
} = require("../lib/db");

function createTestDb(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-shop-test-"));
    const db = initializeDatabase(path.join(directory, "shop.db"), {
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
