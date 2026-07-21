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

        CREATE TABLE orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_number TEXT NOT NULL UNIQUE,
            provider TEXT NOT NULL,
            provider_reference TEXT,
            status TEXT NOT NULL,
            customer_name TEXT NOT NULL,
            customer_email TEXT NOT NULL,
            amount_cents INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'CHF',
            items_json TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);
    const insertProduct = db.prepare(`
        INSERT INTO products (
            slug, product_kind, name, category, categories_json, short_description, description, image_url,
            valid_configurations_json, price_cents, inventory, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertProduct.run(
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
    insertProduct.run(
        "old-inherited-price-product",
        "product",
        "Old inherited price product",
        "",
        "[]",
        "Short",
        "Long",
        "",
        JSON.stringify([
            { selected_options: [{ name: "Storage", value: "256 GB" }], quantity: 1, price_cents: null },
        ]),
        15000,
        1,
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
    assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);

    const columns = db.prepare("PRAGMA table_info(products)").all().map((column) => column.name);
    const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name);
    const adminColumns = db.prepare("PRAGMA table_info(admins)").all().map((column) => column.name);
    const product = db.prepare(`
        SELECT starting_price_cents, maximum_price_cents
        FROM products
        WHERE slug = ?
    `).get("old-configured-product");
    const inheritedPriceProduct = db.prepare(`
        SELECT starting_price_cents, maximum_price_cents
        FROM products
        WHERE slug = ?
    `).get("old-inherited-price-product");
    const migration = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("2026-06-23-product-price-ranges");
    const categoryMigration = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("2026-06-26-product-categories");
    const idempotencyMigration = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("2026-07-21-order-idempotency");
    const authVersionMigration = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("2026-07-21-admin-auth-version");
    const providerReferenceMigration = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("2026-07-21-unique-provider-references");
    const categories = db.prepare(`
        SELECT category, position
        FROM product_categories
        ORDER BY position
    `).all();

    assert.ok(columns.includes("starting_price_cents"));
    assert.ok(columns.includes("maximum_price_cents"));
    assert.ok(orderColumns.includes("idempotency_key"));
    assert.ok(adminColumns.includes("auth_version"));
    assert.deepEqual(product, {
        starting_price_cents: 9000,
        maximum_price_cents: 12000,
    });
    assert.deepEqual(inheritedPriceProduct, {
        starting_price_cents: 15000,
        maximum_price_cents: 15000,
    });
    assert.ok(migration);
    assert.ok(categoryMigration);
    assert.ok(idempotencyMigration);
    assert.ok(authVersionMigration);
    assert.ok(providerReferenceMigration);
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

test("admin bootstrap normalizes surrounding username whitespace", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-admin-username-test-"));
    const databasePath = path.join(directory, "shop.db");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const db = initializeDatabase(databasePath, {
        NODE_ENV: "test",
        ADMIN_USERNAME: "  root-admin  ",
        ADMIN_PASSWORD: "test-admin-password",
    });
    t.after(() => db.close());

    assert.equal(db.prepare("SELECT username FROM admins").get().username, "root-admin");
});

test("provider reference migration rejects ambiguous legacy orders and closes the database", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-provider-migration-test-"));
    const databasePath = path.join(directory, "shop.db");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    createOldProductSchema(databasePath);

    const legacyDb = new Database(databasePath);
    const insertOrder = legacyDb.prepare(`
        INSERT INTO orders (
            order_number, provider, provider_reference, status, customer_name, customer_email,
            amount_cents, items_json, metadata_json, created_at, updated_at
        )
        VALUES (?, 'stripe', 'pi_duplicate', 'pending', 'Client', 'client@example.test', 1000, '[]', '{}', ?, ?)
    `);
    insertOrder.run("RCT-OLD-1", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    insertOrder.run("RCT-OLD-2", "2026-07-01T00:01:00.000Z", "2026-07-01T00:01:00.000Z");
    legacyDb.close();

    assert.throws(
        () => initializeDatabase(databasePath, {
            NODE_ENV: "test",
            ADMIN_PASSWORD: "test-admin-password",
        }),
        /duplicate stripe references exist/
    );

    const reopenedDb = new Database(databasePath);
    assert.equal(
        reopenedDb.prepare("SELECT id FROM schema_migrations WHERE id = ?")
            .get("2026-07-21-unique-provider-references"),
        undefined
    );
    reopenedDb.close();
});
