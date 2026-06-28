const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { hashPassword } = require("../auth");
const logger = require("../logger");
const { assertUsableProductionValue } = require("../production-secrets");

const DEFAULT_SETTINGS = {
    store_name: "RecyTech Shop",
    tagline: "Ordinateurs reconditionnés, Linux préinstallé, impact local.",
    hero_title: "Du matériel reconditionné, prêt à servir.",
    hero_text: "Une boutique simple pour vendre des appareils remis en état avec Linux, à prix accessibles.",
    hero_image_url: "/static/images/illustrations/hero-workshop.jpg",
    hero_points: [
        "Linux préinstallé sur les machines compatibles",
        "Paiement selon les options proposées à la commande",
        "Stock visible avant l'achat",
    ].join("\n"),
    support_email: "contact@recytech.me",
    support_address: "Rue Louis Favre 62, 2017 Boudry",
    bank_account_holder: "",
    bank_name: "",
    bank_account_number: "",
    bank_iban: "",
    bank_bic: "",
    smtp_host: "",
    smtp_port: "587",
    smtp_secure: "0",
    smtp_username: "",
    smtp_password: "",
    smtp_from_name: "RecyTech",
    smtp_from_email: "",
    order_notification_email: "team@recytech.me",
};

function nowIso() {
    return new Date().toISOString();
}

function ensureDirectory(targetPath) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function ensureColumn(db, tableName, columnName, definition) {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (columns.some((column) => column.name === columnName)) {
        return;
    }

    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function ensureSchemaMigrationsTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
    `);
}

function runSchemaMigration(db, id, migrate) {
    const existing = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(id);
    if (existing) {
        return;
    }

    db.transaction(() => {
        logger.info(`[migration] Applying ${id}`);
        migrate();
        db.prepare(`
            INSERT INTO schema_migrations (id, applied_at)
            VALUES (?, ?)
        `).run(id, nowIso());
    })();
}

function runSchemaMigrations(db) {
    ensureSchemaMigrationsTable(db);
    runSchemaMigration(db, "2026-06-23-product-price-ranges", () => {
        ensureColumn(db, "products", "starting_price_cents", "INTEGER NOT NULL DEFAULT 0");
        ensureColumn(db, "products", "maximum_price_cents", "INTEGER NOT NULL DEFAULT 0");
        backfillProductPriceRanges(db);
    });
    runSchemaMigration(db, "2026-06-26-product-categories", () => {
        backfillProductCategories(db);
    });
}

function seedSettings(db) {
    const insert = db.prepare(`
        INSERT INTO settings (key, value)
        VALUES (@key, @value)
        ON CONFLICT(key) DO NOTHING
    `);

    const transaction = db.transaction((entries) => {
        for (const [key, value] of Object.entries(entries)) {
            insert.run({ key, value });
        }
    });

    transaction(DEFAULT_SETTINGS);
}

function seedAdmin(db, env) {
    const adminCount = db.prepare("SELECT COUNT(*) AS count FROM admins").get().count;
    if (adminCount > 0) {
        return;
    }

    const username = env.ADMIN_USERNAME || "admin";
    const isProduction = env.NODE_ENV === "production";
    const configuredPassword = String(env.ADMIN_PASSWORD || "").trim();
    if (isProduction) {
        assertUsableProductionValue("ADMIN_PASSWORD", configuredPassword, {
            minLength: 12,
        });
    }

    const password = configuredPassword || crypto.randomBytes(18).toString("base64url");
    if (!env.ADMIN_PASSWORD) {
        logger.warn(`[security] No ADMIN_PASSWORD provided. Seeded admin '${username}' with a generated password: ${password}`);
    }

    db.prepare(`
        INSERT INTO admins (username, password_hash, role, created_at)
        VALUES (?, ?, ?, ?)
    `).run(username, hashPassword(password), "superadmin", nowIso());
}

function ensureSuperadmin(db) {
    const superadminCount = db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role = 'superadmin'").get().count;
    if (superadminCount > 0) {
        return;
    }

    const fallbackAdmin = db.prepare("SELECT id FROM admins ORDER BY id ASC LIMIT 1").get();
    if (fallbackAdmin) {
        db.prepare("UPDATE admins SET role = 'superadmin' WHERE id = ?").run(fallbackAdmin.id);
    }
}

function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function normalizeCategoryKey(value) {
    return String(value || "").trim().toLocaleLowerCase("fr-CH");
}

function uniqueCategoryNames(values) {
    const seen = new Set();
    const categories = [];

    for (const value of values) {
        const category = String(value || "").trim();
        const key = normalizeCategoryKey(category);

        if (!category || seen.has(key)) {
            continue;
        }

        seen.add(key);
        categories.push(category);
    }

    return categories;
}

function readStoredProductCategories(row) {
    const categories = [];
    const parsedCategories = parseJsonArray(row?.categories_json);

    if (Array.isArray(parsedCategories)) {
        categories.push(...parsedCategories);
    }

    if (row?.category) {
        categories.push(row.category);
    }

    return uniqueCategoryNames(categories);
}

function readStoredProductPriceRange(row) {
    const basePriceCents = Math.max(0, Number.parseInt(row.price_cents, 10) || 0);
    const configurationPrices = parseJsonArray(row.valid_configurations_json)
        .map((configuration) => {
            const value = Array.isArray(configuration) ? null : configuration?.price_cents;
            const priceCents = Number(value);
            return Number.isInteger(priceCents) && priceCents >= 0 ? priceCents : basePriceCents;
        });

    if (!configurationPrices.length) {
        return {
            startingPriceCents: basePriceCents,
            maximumPriceCents: basePriceCents,
        };
    }

    return {
        startingPriceCents: Math.min(...configurationPrices),
        maximumPriceCents: Math.max(...configurationPrices),
    };
}

function backfillProductPriceRanges(db) {
    const rows = db.prepare(`
        SELECT id, price_cents, valid_configurations_json
        FROM products
        WHERE starting_price_cents = 0
           OR maximum_price_cents = 0
           OR starting_price_cents > maximum_price_cents
    `).all();
    const update = db.prepare(`
        UPDATE products
        SET starting_price_cents = ?,
            maximum_price_cents = ?
        WHERE id = ?
    `);

    const transaction = db.transaction(() => {
        for (const row of rows) {
            const range = readStoredProductPriceRange(row);
            update.run(range.startingPriceCents, range.maximumPriceCents, row.id);
        }
    });

    transaction();
}

function backfillProductCategories(db) {
    const rows = db.prepare(`
        SELECT id, category, categories_json
        FROM products
    `).all();
    const insert = db.prepare(`
        INSERT INTO product_categories (product_id, category, category_key, position)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(product_id, category_key) DO UPDATE SET
            category = excluded.category,
            position = excluded.position
    `);

    const transaction = db.transaction(() => {
        for (const row of rows) {
            readStoredProductCategories(row).forEach((category, index) => {
                insert.run(row.id, category, normalizeCategoryKey(category), index);
            });
        }
    });

    transaction();
}

function configureDatabaseLogger(env = {}) {
    if (!env.LOG_LEVEL && !env.LOG_FORMAT && env.NODE_ENV !== "test") {
        return;
    }

    logger.configureLogger({
        level: env.LOG_LEVEL || (env.NODE_ENV === "test" ? "silent" : "info"),
        format: env.LOG_FORMAT || "text",
    });
}

function initializeDatabase(databasePath, env) {
    configureDatabaseLogger(env);
    ensureDirectory(databasePath);
    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    db.exec(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'admin',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL UNIQUE,
            product_kind TEXT NOT NULL DEFAULT 'product',
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT '',
            categories_json TEXT NOT NULL DEFAULT '[]',
            short_description TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            admin_notes TEXT NOT NULL DEFAULT '',
            image_url TEXT NOT NULL DEFAULT '',
            image_gallery_json TEXT NOT NULL DEFAULT '[]',
            option_groups_json TEXT NOT NULL DEFAULT '[]',
            info_rows_json TEXT NOT NULL DEFAULT '[]',
            valid_configurations_json TEXT NOT NULL DEFAULT '[]',
            bundle_items_json TEXT NOT NULL DEFAULT '[]',
            price_cents INTEGER NOT NULL,
            starting_price_cents INTEGER NOT NULL DEFAULT 0,
            maximum_price_cents INTEGER NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'CHF',
            inventory INTEGER NOT NULL DEFAULT 0,
            featured INTEGER NOT NULL DEFAULT 0,
            published INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS product_categories (
            product_id INTEGER NOT NULL,
            category TEXT NOT NULL,
            category_key TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (product_id, category_key),
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS orders (
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

        CREATE TABLE IF NOT EXISTS promo_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            discount_type TEXT NOT NULL,
            discount_value INTEGER NOT NULL,
            minimum_order_cents INTEGER NOT NULL DEFAULT 0,
            max_redemptions INTEGER,
            times_redeemed INTEGER NOT NULL DEFAULT 0,
            starts_on TEXT,
            expires_on TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS site_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rating INTEGER NOT NULL,
            reviewer_name TEXT NOT NULL,
            reviewer_email TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL,
            approved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);

    ensureColumn(db, "admins", "role", "TEXT NOT NULL DEFAULT 'admin'");
    ensureColumn(db, "products", "category", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "products", "categories_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "products", "admin_notes", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "products", "image_gallery_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "products", "option_groups_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "products", "info_rows_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "products", "valid_configurations_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "products", "product_kind", "TEXT NOT NULL DEFAULT 'product'");
    ensureColumn(db, "products", "bundle_items_json", "TEXT NOT NULL DEFAULT '[]'");
    runSchemaMigrations(db);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_site_reviews_approved_created_at
        ON site_reviews (approved, created_at);

        CREATE INDEX IF NOT EXISTS idx_products_published_featured_created_at
        ON products (published, featured, created_at);

        CREATE INDEX IF NOT EXISTS idx_products_published_kind_created_at
        ON products (published, product_kind, created_at);

        CREATE INDEX IF NOT EXISTS idx_products_published_inventory
        ON products (published, inventory);

        CREATE INDEX IF NOT EXISTS idx_products_published_price_range
        ON products (published, starting_price_cents, maximum_price_cents);

        CREATE INDEX IF NOT EXISTS idx_product_categories_category_key
        ON product_categories (category_key, product_id);

        CREATE INDEX IF NOT EXISTS idx_product_categories_product_position
        ON product_categories (product_id, position);

        CREATE INDEX IF NOT EXISTS idx_orders_status_created_at
        ON orders (status, created_at);

        CREATE INDEX IF NOT EXISTS idx_orders_provider_reference
        ON orders (provider, provider_reference);

        CREATE INDEX IF NOT EXISTS idx_promo_codes_active
        ON promo_codes (active);
    `);

    seedSettings(db);
    seedAdmin(db, env);
    ensureSuperadmin(db);

    return db;
}

module.exports = {
    DEFAULT_SETTINGS,
    initializeDatabase,
};
