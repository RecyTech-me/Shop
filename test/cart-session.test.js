const assert = require("node:assert/strict");
const test = require("node:test");
const { createCartSessionHelpers } = require("../lib/cart-session");

const selectedOptions = [{ name: "RAM", value: "16 GB" }];
const configuredProduct = {
    id: 42,
    slug: "thinkpad-test",
    name: "ThinkPad Test",
    product_kind: "product",
    published: 1,
    is_pack: false,
    category: "Ordinateurs",
    categories: ["Ordinateurs"],
    short_description: "Portable reconditionné",
    image_url: "/static/uploads/products/test.jpg",
    price_cents: 40000,
    inventory: 3,
    valid_configurations: [{
        selections: selectedOptions,
        quantity: 2,
        price_cents: 50000,
        service_tags: ["TAG-1", "TAG-2"],
    }],
};

function createHelpers(product = configuredProduct) {
    return createCartSessionHelpers({
        db: {},
        getProductById: (db, productId) => productId === product.id ? product : null,
        normalizeText: (value) => String(value || "").trim(),
        normalizeSingleLineText: (value) => String(value || "").trim().replace(/\s+/g, " "),
        productCategoryList: (item) => item.categories || [],
    });
}

test("configured product availability and price come from the matching configuration", () => {
    const helpers = createHelpers();

    assert.equal(helpers.getConfigurationAvailableQuantity(configuredProduct, selectedOptions), 2);
    assert.equal(helpers.getProductUnitPriceCents(configuredProduct, selectedOptions), 50000);
    assert.throws(() => helpers.ensureAvailableProductQuantity(configuredProduct, selectedOptions, 3), /Stock insuffisant/);
});

test("service tag validation requires exactly the sold tags for serialized units", () => {
    const helpers = createHelpers();

    assert.deepEqual(
        helpers.validateRequestedServiceTags(configuredProduct, selectedOptions, ["TAG-2", "TAG-1"], 2),
        ["TAG-2", "TAG-1"]
    );
    assert.throws(
        () => helpers.validateRequestedServiceTags(configuredProduct, selectedOptions, ["TAG-1"], 2),
        /exactement 2/
    );
    assert.throws(
        () => helpers.validateRequestedServiceTags(configuredProduct, selectedOptions, ["TAG-3"], 1),
        /ne correspondent pas/
    );
});

test("cart builder skips invalid items and clamps quantity to available stock", () => {
    const helpers = createHelpers();
    const req = {
        session: {
            cart: [
                { productId: 42, quantity: 5, selectedOptions },
                { productId: 999, quantity: 1, selectedOptions: [] },
            ],
        },
    };

    const cart = helpers.buildCart(req);

    assert.equal(cart.items.length, 1);
    assert.equal(cart.items[0].quantity, 2);
    assert.equal(cart.items[0].unit_price_cents, 50000);
    assert.equal(cart.subtotalCents, 100000);
    assert.equal(cart.itemCount, 2);
});
