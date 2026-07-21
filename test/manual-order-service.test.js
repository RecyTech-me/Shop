const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCartSessionHelpers } = require("../lib/cart-session");
const { createCheckoutStateHelpers } = require("../lib/checkout-state");
const { createManualOrderService } = require("../lib/manual-order-service");
const { createProductOptionReader } = require("../lib/product-option-reader");
const {
    createProduct,
    getDashboardStats,
    getProductById,
    getPromoCodeByCode,
    initializeDatabase,
    createOrder,
    markOrderPaid,
    reserveOrderInventory,
    updateOrderRecord,
} = require("../lib/db");
const {
    normalizeText,
    normalizeSingleLineText,
    parseInteger,
    parseMoneyToCents,
    parseOptionalMoneyToCents,
    normalizeOrderDateTimeField,
} = require("../lib/input-utils");
const {
    SHIPPING_OPTIONS,
    PAYMENT_DISCOUNT_RATE,
    formatMoney,
} = require("../lib/shop-formatters");

function createTestDb(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-manual-order-test-"));
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

function productCategoryList(product) {
    return Array.isArray(product?.categories) && product.categories.length
        ? product.categories
        : [product?.category].filter(Boolean);
}

function createService(db, overrides = {}) {
    const cart = createCartSessionHelpers({
        db,
        getProductById,
        normalizeText,
        normalizeSingleLineText,
        parseInteger,
        productCategoryList,
    });
    const checkout = createCheckoutStateHelpers({
        SHIPPING_OPTIONS,
        PAYMENT_DISCOUNT_RATE,
        formatMoney,
        getPromoCodeByCode: (code) => getPromoCodeByCode(db, code),
        normalizeText,
        paymentState: () => ({
            stripeEnabled: false,
            bitcoinEnabled: false,
            transferEnabled: true,
        }),
    });
    const { readSelectedProductOptions } = createProductOptionReader({
        normalizeText,
        getProductUnitPriceCents: cart.getProductUnitPriceCents,
    });

    return createManualOrderService({
        db,
        normalizeText,
        normalizeSingleLineText,
        parseInteger,
        parseMoneyToCents,
        parseOptionalMoneyToCents,
        normalizeOrderDateTimeField,
        normalizePromoCode: checkout.normalizePromoCode,
        readSelectedProductOptions,
        ensureAvailableProductQuantity: cart.ensureAvailableProductQuantity,
        validateRequestedServiceTags: cart.validateRequestedServiceTags,
        getProductUnitPriceCents: cart.getProductUnitPriceCents,
        getConfigurationAvailableQuantity: cart.getConfigurationAvailableQuantity,
        productCategoryList,
        snapshotPackBundleItems: cart.snapshotPackBundleItems,
        getPromoCodeOutcome: checkout.getPromoCodeOutcome,
        getPromoCodeLabel: checkout.getPromoCodeLabel,
        getProductById,
        createOrder,
        markOrderPaid,
        reserveOrderInventory,
        updateOrderRecord,
        ...overrides,
    });
}

test("manual order service creates paid orders, records received amount, and consumes stock", (t) => {
    const db = createTestDb(t);
    const service = createService(db);
    const product = createProduct(db, {
        product_kind: "product",
        name: "Manual order laptop",
        categories: "Ordinateurs",
        price_chf: "100.00",
        inventory: "2",
        published: "1",
        option_groups: "Grade: A",
        valid_configurations: "Grade=A ; stock=2 ; tags=MAN-1 | MAN-2 => 120.00",
    });

    const order = service.createManualOrder({
        customer_name: "Manual Customer",
        customer_email: "manual@example.test",
        customer_phone: "+41790000000",
        payment_label: "Espèces",
        order_created_at: "2026-06-23T10:00",
        product_id: String(product.id),
        selected_option_0: "A",
        service_tags: "MAN-1",
        quantity: "1",
        unit_price_chf: "",
        discount_chf: "5.00",
        actual_received_chf: "130.00",
        promo_code: "",
        status: "paid",
        internal_note: "Paid manually.",
    }, {
        id: 7,
        username: "admin",
    });
    const nextProduct = getProductById(db, product.id);
    const stats = getDashboardStats(db);

    assert.equal(order.provider, "manual");
    assert.equal(order.status, "paid");
    assert.equal(order.amount_cents, 11500);
    assert.equal(order.metadata.payment.received_amount_cents, 13000);
    assert.equal(order.metadata.manual.created_by_admin_id, 7);
    assert.equal(order.metadata.manual.payment_label, "Espèces");
    assert.equal(order.metadata.manual.discount_cents, 500);
    assert.equal(order.metadata.admin.internal_note, "Paid manually.");
    assert.deepEqual(order.items[0].selected_options, [{ name: "Grade", value: "A" }]);
    assert.deepEqual(order.items[0].service_tags, ["MAN-1"]);
    assert.equal(nextProduct.inventory, 1);
    assert.equal(nextProduct.valid_configurations[0].quantity, 1);
    assert.deepEqual(nextProduct.valid_configurations[0].service_tags, ["MAN-2"]);
    assert.equal(stats.paidOrders, 1);
    assert.equal(stats.revenueCents, 13000);
});

test("manual pending orders reserve stock until payment or cancellation", (t) => {
    const db = createTestDb(t);
    const service = createService(db);
    const product = createProduct(db, {
        product_kind: "product",
        name: "Manual pending monitor",
        categories: "Écrans",
        price_chf: "80.00",
        inventory: "1",
        published: "1",
        option_groups: "",
        valid_configurations: "",
    });

    const order = service.createManualOrder({
        customer_name: "Pending Customer",
        customer_email: "pending@example.test",
        customer_phone: "",
        payment_label: "Virement",
        order_created_at: "2026-06-23T11:00",
        product_id: String(product.id),
        quantity: "1",
        unit_price_chf: "",
        discount_chf: "0.00",
        actual_received_chf: "",
        promo_code: "",
        status: "awaiting_transfer",
        internal_note: "",
    });
    const nextProduct = getProductById(db, product.id);

    assert.equal(order.status, "awaiting_transfer");
    assert.equal(order.amount_cents, 8000);
    assert.ok(order.metadata.inventory_reserved_at);
    assert.equal(nextProduct.inventory, 0);

    const cancelledOrder = updateOrderRecord(db, order.id, { status: "cancelled" });
    assert.ok(cancelledOrder.metadata.inventory_released_at);
    assert.equal(getProductById(db, product.id).inventory, 1);
});

test("manual order creation rolls back when reservation cannot be completed", (t) => {
    const db = createTestDb(t);
    const service = createService(db, {
        reserveOrderInventory() {
            throw new Error("Simulated reservation failure");
        },
    });
    const product = createProduct(db, {
        product_kind: "product",
        name: "Manual rollback item",
        categories: "Accessoires",
        price_chf: "20.00",
        inventory: "1",
        published: "1",
    });

    assert.throws(() => service.createManualOrder({
        customer_name: "Rollback Customer",
        customer_email: "rollback@example.test",
        payment_label: "Virement",
        order_created_at: "2026-06-23T11:00",
        product_id: String(product.id),
        quantity: "1",
        status: "awaiting_transfer",
    }), /Simulated reservation failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
});

test("manual order input rejects partial identifiers and non-positive quantities", (t) => {
    const db = createTestDb(t);
    const service = createService(db);

    assert.throws(() => service.readManualOrderInput({
        customer_name: "Invalid Customer",
        product_id: "12junk",
        quantity: "1",
    }), /Produit invalide/);

    assert.throws(() => service.readManualOrderInput({
        customer_name: "Invalid Customer",
        product_id: "12",
        quantity: "0",
    }), /Quantité invalide/);
});
