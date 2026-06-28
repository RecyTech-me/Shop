const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    createProduct,
    initializeDatabase,
    listAdminProductRows,
    listAdminCategories,
    listProductCategories,
    listPacksContainingProduct,
    listPublishedProducts,
    deleteProductCategory,
} = require("../lib/db");

function createTestDb(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-products-test-"));
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

test("published product listing uses stored price ranges for SQL filtering and sorting", (t) => {
    const db = createTestDb(t);
    createProduct(db, {
        product_kind: "product",
        name: "Budget monitor",
        categories: "Écrans",
        price_chf: "40.00",
        inventory: "1",
        published: "1",
    });
    createProduct(db, {
        product_kind: "product",
        name: "Configurable laptop",
        categories: "Ordinateurs",
        price_chf: "400.00",
        inventory: "3",
        published: "1",
        option_groups: "RAM: 8 GB | 16 GB",
        valid_configurations: [
            "RAM=8 GB ; stock=1 => 350.00",
            "RAM=16 GB ; stock=1 => 550.00",
        ].join("\n"),
    });
    createProduct(db, {
        product_kind: "product",
        name: "Premium workstation",
        categories: "Ordinateurs",
        price_chf: "1200.00",
        inventory: "1",
        published: "1",
    });

    const filtered = listPublishedProducts(db, {
        minPriceCents: 30000,
        maxPriceCents: 60000,
        sort: "price_asc",
    });

    assert.deepEqual(filtered.map((product) => product.name), ["Configurable laptop"]);
    assert.equal(filtered[0].starting_price_cents, 35000);
    assert.equal(filtered[0].maximum_price_cents, 55000);

    const descending = listPublishedProducts(db, {
        sort: "price_desc",
        limit: 2,
    });

    assert.deepEqual(descending.map((product) => product.name), [
        "Premium workstation",
        "Configurable laptop",
    ]);

    const categoryLimited = listPublishedProducts(db, {
        category: "écrans",
        sort: "price_desc",
        limit: 1,
    });

    assert.deepEqual(categoryLimited.map((product) => product.name), ["Budget monitor"]);
});

test("admin product rows and category deletion avoid full product hydration", (t) => {
    const db = createTestDb(t);
    createProduct(db, {
        product_kind: "product",
        name: "Accessory one",
        categories: "Accessoires\nPromo",
        price_chf: "15.00",
        inventory: "2",
        admin_notes: "Private note",
        published: "1",
    });
    createProduct(db, {
        product_kind: "product",
        name: "Accessory two",
        categories: "Accessoires",
        price_chf: "20.00",
        inventory: "1",
        published: "",
    });

    const rows = listAdminProductRows(db);
    const firstAccessory = rows.find((product) => product.name === "Accessory one");
    assert.deepEqual(rows.map((product) => product.name).sort(), ["Accessory one", "Accessory two"]);
    assert.deepEqual(firstAccessory.categories, ["Accessoires", "Promo"]);
    assert.equal(firstAccessory.is_pack, false);
    assert.equal(firstAccessory.option_groups, undefined);
    assert.deepEqual(listProductCategories(db), ["Accessoires", "Promo"]);
    assert.deepEqual(listAdminCategories(db), [{
        name: "Accessoires",
        product_count: 2,
        published_product_count: 1,
    }, {
        name: "Promo",
        product_count: 1,
        published_product_count: 1,
    }]);

    const deleted = deleteProductCategory(db, "Accessoires");
    assert.equal(deleted.updatedProducts, 2);
    assert.deepEqual(listAdminProductRows(db).find((product) => product.name === "Accessory one").categories, ["Promo"]);
    assert.deepEqual(listProductCategories(db), ["Promo"]);
    assert.deepEqual(db.prepare("SELECT category FROM product_categories ORDER BY category").all(), [{ category: "Promo" }]);
});

test("pack reference checks read bundle JSON without hydrating pack products", (t) => {
    const db = createTestDb(t);
    const component = createProduct(db, {
        product_kind: "product",
        name: "Pack component",
        categories: "Ordinateurs",
        price_chf: "100.00",
        inventory: "3",
        published: "1",
    });
    createProduct(db, {
        product_kind: "pack",
        name: "Starter pack",
        categories: "Packs",
        price_chf: "120.00",
        inventory: "0",
        published: "1",
        bundle_items: `#${component.id}; qty=1`,
    });

    const packs = listPacksContainingProduct(db, component.id);
    assert.deepEqual(packs.map((product) => product.name), ["Starter pack"]);
    assert.equal(packs[0].bundle_items, undefined);
});

test("published product availability filters use hydrated pack inventory", (t) => {
    const db = createTestDb(t);
    const availableComponent = createProduct(db, {
        product_kind: "product",
        name: "Available component",
        categories: "Ordinateurs",
        price_chf: "100.00",
        inventory: "2",
        published: "1",
    });
    const soldOutComponent = createProduct(db, {
        product_kind: "product",
        name: "Sold out component",
        categories: "Ordinateurs",
        price_chf: "100.00",
        inventory: "0",
        published: "1",
    });
    createProduct(db, {
        product_kind: "pack",
        name: "Available pack",
        categories: "Packs",
        price_chf: "120.00",
        published: "1",
        bundle_items: `#${availableComponent.id}; qty=1`,
    });
    createProduct(db, {
        product_kind: "pack",
        name: "Sold out pack",
        categories: "Packs",
        price_chf: "120.00",
        published: "1",
        bundle_items: `#${soldOutComponent.id}; qty=1`,
    });

    const inStock = listPublishedProducts(db, {
        availability: "in_stock",
        category: "Packs",
        sort: "name_asc",
    });
    const outOfStock = listPublishedProducts(db, {
        availability: "out_of_stock",
        category: "Packs",
        sort: "name_asc",
    });

    assert.deepEqual(inStock.map((product) => [product.name, product.inventory]), [["Available pack", 2]]);
    assert.deepEqual(outOfStock.map((product) => [product.name, product.inventory]), [["Sold out pack", 0]]);
});

test("published pack availability filtering refills pages after hydrated filtering", (t) => {
    const db = createTestDb(t);
    const availableComponent = createProduct(db, {
        product_kind: "product",
        name: "Pagination available component",
        categories: "Ordinateurs",
        price_chf: "100.00",
        inventory: "3",
        published: "1",
    });
    const soldOutComponent = createProduct(db, {
        product_kind: "product",
        name: "Pagination sold out component",
        categories: "Ordinateurs",
        price_chf: "100.00",
        inventory: "0",
        published: "1",
    });

    for (let index = 0; index < 5; index += 1) {
        createProduct(db, {
            product_kind: "pack",
            name: `A sold out pack ${index}`,
            categories: "Packs",
            price_chf: "120.00",
            published: "1",
            bundle_items: `#${soldOutComponent.id}; qty=1`,
        });
    }

    createProduct(db, {
        product_kind: "pack",
        name: "Z available pack 1",
        categories: "Packs",
        price_chf: "120.00",
        published: "1",
        bundle_items: `#${availableComponent.id}; qty=1`,
    });
    createProduct(db, {
        product_kind: "pack",
        name: "Z available pack 2",
        categories: "Packs",
        price_chf: "120.00",
        published: "1",
        bundle_items: `#${availableComponent.id}; qty=1`,
    });

    const inStock = listPublishedProducts(db, {
        availability: "in_stock",
        category: "Packs",
        sort: "name_asc",
        limit: 2,
    });

    assert.deepEqual(inStock.map((product) => product.name), [
        "Z available pack 1",
        "Z available pack 2",
    ]);
});
