const assert = require("node:assert/strict");
const test = require("node:test");
const { createOrderViewTokenHelpers } = require("../lib/payments/order-view-token");

function createOrder(overrides = {}) {
    return {
        order_number: "RCT-2026-0001",
        customer_email: "buyer@example.test",
        amount_cents: 12990,
        provider: "stripe",
        ...overrides,
    };
}

test("order view tokens are deterministic and validate for the bound order", () => {
    const helpers = createOrderViewTokenHelpers("test-order-view-secret");
    const order = createOrder();
    const token = helpers.createOrderViewToken(order);

    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(helpers.createOrderViewToken(order), token);
    assert.equal(helpers.verifyOrderViewToken(order, `  ${token}  `), true);
});

test("order view token verification rejects missing and tampered values", () => {
    const helpers = createOrderViewTokenHelpers("test-order-view-secret");
    const order = createOrder();
    const token = helpers.createOrderViewToken(order);
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    assert.equal(helpers.createOrderViewToken(null), "");
    assert.equal(helpers.verifyOrderViewToken(order, ""), false);
    assert.equal(helpers.verifyOrderViewToken(order, tampered), false);
    assert.equal(helpers.verifyOrderViewToken(order, `${token}extra`), false);
});

test("order view tokens cannot be reused for another order or secret", () => {
    const helpers = createOrderViewTokenHelpers("test-order-view-secret");
    const token = helpers.createOrderViewToken(createOrder());

    assert.equal(helpers.verifyOrderViewToken(createOrder({ amount_cents: 12991 }), token), false);
    assert.equal(helpers.verifyOrderViewToken(createOrder({ customer_email: "other@example.test" }), token), false);
    assert.equal(createOrderViewTokenHelpers("different-secret").verifyOrderViewToken(createOrder(), token), false);
    assert.equal(createOrderViewTokenHelpers("").createOrderViewToken(createOrder()), "");
});
