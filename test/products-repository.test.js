const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    createProduct,
    initializeDatabase,
    listPublishedProducts,
} = require("../lib/db");

function createTestDb(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-products-test-"));
    const db = initializeDatabase(path.join(directory, "shop.db"), {
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
        category: "Écrans",
        sort: "price_desc",
        limit: 1,
    });

    assert.deepEqual(categoryLimited.map((product) => product.name), ["Budget monitor"]);
});
