const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { initializeDatabase } = require("../lib/db");

function createOldProductSchema(databasePath) {
    const db = new Database(databasePath);

    db.exec(`
        CREATE TABLE products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            product_kind TEXT NOT NULL DEFAULT 'product',
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT '',
            categories_json TEXT NOT NULL DEFAULT '[]',
            short_description TEXT NOT NULL,
            description TEXT NOT NULL,
            admin_notes TEXT NOT NULL DEFAULT '',
            image_url TEXT NOT NULL,
            image_gallery_json TEXT NOT NULL DEFAULT '[]',
            option_groups_json TEXT NOT NULL DEFAULT '[]',
            info_rows_json TEXT NOT NULL DEFAULT '[]',
            valid_configurations_json TEXT NOT NULL DEFAULT '[]',
            bundle_items_json TEXT NOT NULL DEFAULT '[]',
            price_cents INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'CHF',
            inventory INTEGER NOT NULL,
            featured INTEGER NOT NULL DEFAULT 0,
            published INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);
    db.prepare(`
        INSERT INTO products (
            slug, product_kind, name, category, categories_json, short_description, description, image_url,
            valid_configurations_json, price_cents, inventory, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "old-configured-product",
        "product",
        "Old configured product",
        "Ordinateurs",
        JSON.stringify(["Ordinateurs", "Promos"]),
        "Short",
        "Long",
        "",
        JSON.stringify([
            { selected_options: [{ name: "RAM", value: "8 GB" }], quantity: 1, price_cents: 9000 },
            { selected_options: [{ name: "RAM", value: "16 GB" }], quantity: 1, price_cents: 12000 },
        ]),
        10000,
        2,
        "2026-06-23T00:00:00.000Z",
        "2026-06-23T00:00:00.000Z"
    );
    db.close();
}

test("schema migrations add and backfill product price ranges on old databases", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-schema-migration-"));
    const databasePath = path.join(directory, "shop.db");

    t.after(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    createOldProductSchema(databasePath);

    const db = initializeDatabase(databasePath, {
        NODE_ENV: "test",
        ADMIN_PASSWORD: "test-admin-password",
    });
    t.after(() => db.close());

    const columns = db.prepare("PRAGMA table_info(products)").all().map((column) => column.name);
    const product = db.prepare(`
        SELECT starting_price_cents, maximum_price_cents
        FROM products
        WHERE slug = ?
    `).get("old-configured-product");
    const migration = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("2026-06-23-product-price-ranges");
    const categoryMigration = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("2026-06-26-product-categories");
    const categories = db.prepare(`
        SELECT category, position
        FROM product_categories
        ORDER BY position
    `).all();

    assert.ok(columns.includes("starting_price_cents"));
    assert.ok(columns.includes("maximum_price_cents"));
    assert.deepEqual(product, {
        starting_price_cents: 9000,
        maximum_price_cents: 12000,
    });
    assert.ok(migration);
    assert.ok(categoryMigration);
    assert.deepEqual(categories, [
        { category: "Ordinateurs", position: 0 },
        { category: "Promos", position: 1 },
    ]);
});

test("production admin bootstrap rejects placeholder passwords", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-admin-bootstrap-test-"));
    const databasePath = path.join(directory, "shop.db");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    assert.throws(() => initializeDatabase(databasePath, {
        NODE_ENV: "production",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "change-me-now",
    }), /placeholder/);
});
