const assert = require("node:assert/strict");
const test = require("node:test");
const {
    parseOptionGroupsStrict,
    parseValidConfigurationsStrict,
    parseProduct,
    getConfigurationAvailableQuantity,
} = require("../lib/product-normalizers");

test("strict option parsing rejects malformed groups and keeps valid values", () => {
    const groups = parseOptionGroupsStrict("RAM: 8 GB | 16 GB\nSSD: 256 GB | 512 GB");

    assert.deepEqual(groups, [
        { name: "RAM", values: ["8 GB", "16 GB"] },
        { name: "SSD", values: ["256 GB", "512 GB"] },
    ]);
    assert.throws(() => parseOptionGroupsStrict("RAM 8 GB | 16 GB"), /format/);
});

test("strict configurations validate option names, values, stock, tags, and price", () => {
    const groups = parseOptionGroupsStrict("RAM: 8 GB | 16 GB\nSSD: 256 GB | 512 GB");
    const configurations = parseValidConfigurationsStrict(
        "RAM=16 GB ; SSD=512 GB ; stock=2 ; tags=SER-1 | SER-2 => 499.90",
        groups
    );

    assert.deepEqual(configurations, [{
        selections: [
            { name: "RAM", value: "16 GB" },
            { name: "SSD", value: "512 GB" },
        ],
        price_cents: 49990,
        quantity: 2,
        service_tags: ["SER-1", "SER-2"],
    }]);
    assert.throws(
        () => parseValidConfigurationsStrict("RAM=32 GB ; SSD=512 GB", groups),
        /pas autorisée/
    );
    assert.throws(
        () => parseValidConfigurationsStrict("RAM=16 GB ; SSD=512 GB ; stock=2units", groups),
        /stock invalide/
    );
    assert.throws(
        () => parseValidConfigurationsStrict("RAM=16 GB ; SSD=512 GB => 999999999999999999999", groups),
        /prix invalide/
    );
    assert.throws(
        () => parseValidConfigurationsStrict("RAM=16 GB ; SSD=512 GB => 1e3", groups),
        /prix invalide/
    );
});

test("parsed products normalize configuration quantities and availability", () => {
    const product = parseProduct({
        id: 1,
        product_kind: "product",
        name: "ThinkPad",
        slug: "thinkpad",
        category: "Ordinateurs",
        categories_json: JSON.stringify(["Ordinateurs", "Portables"]),
        price_cents: 40000,
        currency: "CHF",
        inventory: 4,
        published: 1,
        featured: 0,
        image_gallery_json: JSON.stringify(["/a.jpg"]),
        option_groups_json: JSON.stringify([{ name: "RAM", values: ["16 GB"] }]),
        valid_configurations_json: JSON.stringify([{
            selections: [{ name: "RAM", value: "16 GB" }],
            price_cents: 50000,
            quantity: 2,
        }]),
        bundle_items_json: "[]",
        info_rows_json: "[]",
    });

    assert.equal(product.slug, "thinkpad");
    assert.deepEqual(product.categories, ["Ordinateurs", "Portables"]);
    assert.equal(getConfigurationAvailableQuantity(product, [{ name: "RAM", value: "16 GB" }]), 2);
    assert.equal(getConfigurationAvailableQuantity(product, [{ name: "RAM", value: "8 GB" }]), 0);
});
