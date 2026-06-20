const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { hashPassword } = require("./auth");
const {
    uniqueStrings,
    parseLineList,
    parseCategoryListStrict,
    normalizeProductKind,
    parseOptionGroupsStrict,
    parseInfoRows,
    parseValidConfigurationsStrict,
    parseBundleItemsStrict,
    parseProduct,
    hydrateProduct,
    getConfigurationSelections,
    getConfigurationAvailableQuantity,
} = require("./product-normalizers");

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

function normalizePromoCodeValue(value) {
    return String(value || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
}

function slugify(value) {
    return value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/[-\s]+/g, "-")
        .replace(/^-+|-+$/g, "") || "produit";
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

function initializeDatabase(databasePath, env) {
    ensureDirectory(databasePath);
    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");

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
            currency TEXT NOT NULL DEFAULT 'CHF',
            inventory INTEGER NOT NULL DEFAULT 0,
            featured INTEGER NOT NULL DEFAULT 0,
            published INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
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

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_site_reviews_approved_created_at
        ON site_reviews (approved, created_at);
    `);

    seedSettings(db);
    seedAdmin(db, env);
    ensureSuperadmin(db);

    return db;
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
    const password = env.ADMIN_PASSWORD || crypto.randomBytes(18).toString("base64url");
    if (!env.ADMIN_PASSWORD) {
        console.warn(`[security] No ADMIN_PASSWORD provided. Seeded admin '${username}' with a generated password: ${password}`);
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

function getSettings(db) {
    const rows = db.prepare("SELECT key, value FROM settings").all();
    return rows.reduce((accumulator, row) => {
        accumulator[row.key] = row.value;
        return accumulator;
    }, { ...DEFAULT_SETTINGS });
}

function saveSettings(db, values) {
    const upsert = db.prepare(`
        INSERT INTO settings (key, value)
        VALUES (@key, @value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    const transaction = db.transaction((entries) => {
        for (const [key, value] of Object.entries(entries)) {
            upsert.run({ key, value });
        }
    });

    transaction(values);
}

function makeUniqueSlug(db, name, productId = null) {
    const baseSlug = slugify(name);
    let candidate = baseSlug;
    let suffix = 2;

    while (true) {
        const existing = productId
            ? db.prepare("SELECT id FROM products WHERE slug = ? AND id != ?").get(candidate, productId)
            : db.prepare("SELECT id FROM products WHERE slug = ?").get(candidate);

        if (!existing) {
            return candidate;
        }

        candidate = `${baseSlug}-${suffix}`;
        suffix += 1;
    }
}

function normalizeProductInput(input) {
    const primaryImage = String(input.image_url || "").trim();
    const productKind = normalizeProductKind(input.product_kind);
    const categories = parseCategoryListStrict(input.categories || input.category);
    const imageGallery = uniqueStrings(
        parseLineList(input.image_gallery_urls).filter((url) => url !== primaryImage)
    );
    const optionGroups = productKind === "pack" ? [] : parseOptionGroupsStrict(input.option_groups);
    const infoRows = parseInfoRows(input.info_rows);
    const validConfigurations = productKind === "pack"
        ? []
        : parseValidConfigurationsStrict(input.valid_configurations, optionGroups);

    if (productKind === "pack") {
        if (String(input.option_groups || "").trim()) {
            throw new Error("Un pack ne peut pas définir ses propres options.");
        }

        if (String(input.valid_configurations || "").trim()) {
            throw new Error("Un pack ne peut pas définir ses propres combinaisons autorisées.");
        }
    }

    return {
        product_kind: productKind,
        name: String(input.name || "").trim(),
        category: categories[0] || "",
        categories_json: JSON.stringify(categories),
        short_description: String(input.short_description || "").trim(),
        description: String(input.description || "").trim(),
        admin_notes: String(input.admin_notes || "").trim(),
        image_url: primaryImage,
        image_gallery_json: JSON.stringify(imageGallery),
        option_groups_json: JSON.stringify(optionGroups),
        info_rows_json: JSON.stringify(infoRows),
        valid_configurations_json: JSON.stringify(validConfigurations),
        bundle_items_json: "[]",
        price_cents: Math.round(Number(input.price_chf || 0) * 100),
        currency: "CHF",
        inventory: productKind === "pack" ? 0 : Math.max(0, Number.parseInt(input.inventory || "0", 10) || 0),
        featured: input.featured ? 1 : 0,
        published: input.published ? 1 : 0,
    };
}

function createProduct(db, input) {
    const product = normalizeProductInput(input);
    const bundleItems = product.product_kind === "pack"
        ? parseBundleItemsStrict(db, input.bundle_items, null)
        : [];

    if (product.product_kind === "pack" && !bundleItems.length) {
        throw new Error("Un pack doit contenir au moins un produit.");
    }

    if (product.product_kind !== "pack" && String(input.bundle_items || "").trim()) {
        throw new Error("Passez le type du produit sur « Pack » pour définir une composition.");
    }

    const timestamp = nowIso();
    const slug = makeUniqueSlug(db, product.name);

    const result = db.prepare(`
        INSERT INTO products (
            slug, product_kind, name, category, categories_json, short_description, description, admin_notes, image_url,
            image_gallery_json, option_groups_json, info_rows_json, valid_configurations_json,
            bundle_items_json,
            price_cents, currency, inventory, featured, published,
            created_at, updated_at
        )
        VALUES (
            @slug, @product_kind, @name, @category, @categories_json, @short_description, @description, @admin_notes, @image_url,
            @image_gallery_json, @option_groups_json, @info_rows_json, @valid_configurations_json,
            @bundle_items_json,
            @price_cents, @currency, @inventory, @featured, @published,
            @created_at, @updated_at
        )
    `).run({
        ...product,
        bundle_items_json: JSON.stringify(bundleItems),
        slug,
        created_at: timestamp,
        updated_at: timestamp,
    });

    return getProductById(db, result.lastInsertRowid);
}

function updateProduct(db, productId, input) {
    const existing = getProductById(db, productId);
    if (!existing) {
        return null;
    }

    const product = normalizeProductInput(input);
    const bundleItems = product.product_kind === "pack"
        ? parseBundleItemsStrict(db, input.bundle_items, productId)
        : [];

    if (product.product_kind === "pack" && !bundleItems.length) {
        throw new Error("Un pack doit contenir au moins un produit.");
    }

    if (product.product_kind !== "pack" && String(input.bundle_items || "").trim()) {
        throw new Error("Passez le type du produit sur « Pack » pour définir une composition.");
    }

    const slug = makeUniqueSlug(db, product.name, productId);

    db.prepare(`
        UPDATE products
        SET slug = @slug,
            product_kind = @product_kind,
            name = @name,
            category = @category,
            categories_json = @categories_json,
            short_description = @short_description,
            description = @description,
            admin_notes = @admin_notes,
            image_url = @image_url,
            image_gallery_json = @image_gallery_json,
            option_groups_json = @option_groups_json,
            info_rows_json = @info_rows_json,
            valid_configurations_json = @valid_configurations_json,
            bundle_items_json = @bundle_items_json,
            price_cents = @price_cents,
            currency = @currency,
            inventory = @inventory,
            featured = @featured,
            published = @published,
            updated_at = @updated_at
        WHERE id = @id
    `).run({
        ...product,
        bundle_items_json: JSON.stringify(bundleItems),
        slug,
        updated_at: nowIso(),
        id: productId,
    });

    return getProductById(db, productId);
}

function deleteProduct(db, productId) {
    return db.prepare("DELETE FROM products WHERE id = ?").run(productId);
}

function listPacksContainingProduct(db, productId) {
    return db.prepare(`
        SELECT *
        FROM products
        WHERE product_kind = 'pack'
    `).all()
        .map(parseProduct)
        .filter((product) => (product.bundle_items || []).some((item) => item.product_id === productId));
}

function listPublishedProducts(db, filters = {}) {
    const conditions = ["published = 1"];
    const values = [];

    const query = String(filters.query || "").trim();
    if (query) {
        conditions.push("(name LIKE ? OR short_description LIKE ? OR description LIKE ?)");
        const pattern = `%${query}%`;
        values.push(pattern, pattern, pattern);
    }

    const category = String(filters.category || "").trim();

    const sqlOrderBy = {
        random: "RANDOM()",
        name_asc: "LOWER(name) ASC, created_at DESC",
        newest: "created_at DESC",
    }[filters.sort] || "featured DESC, created_at DESC";

    let products = db.prepare(`
        SELECT *
        FROM products
        WHERE ${conditions.join(" AND ")}
        ORDER BY ${sqlOrderBy}
    `).all(...values).map(parseProduct).map((product) => hydrateProduct(db, product));

    if (category) {
        const categoryKey = category.toLowerCase();
        products = products.filter((product) =>
            (product.categories || []).some((productCategory) => productCategory.toLowerCase() === categoryKey)
        );
    }

    if (filters.availability === "in_stock") {
        products = products.filter((product) => product.inventory > 0);
    } else if (filters.availability === "out_of_stock") {
        products = products.filter((product) => product.inventory <= 0);
    }

    if (Number.isFinite(filters.minPriceCents)) {
        products = products.filter((product) => product.starting_price_cents >= filters.minPriceCents);
    }

    if (Number.isFinite(filters.maxPriceCents)) {
        products = products.filter((product) => product.starting_price_cents <= filters.maxPriceCents);
    }

    if (filters.sort === "price_asc") {
        products.sort((left, right) =>
            (left.starting_price_cents - right.starting_price_cents) ||
            (right.featured - left.featured) ||
            String(right.created_at).localeCompare(String(left.created_at))
        );
    }

    if (filters.sort === "price_desc") {
        products.sort((left, right) =>
            (right.starting_price_cents - left.starting_price_cents) ||
            (right.featured - left.featured) ||
            String(right.created_at).localeCompare(String(left.created_at))
        );
    }

    return products;
}

function listFeaturedProducts(db) {
    return db.prepare(`
        SELECT *
        FROM products
        WHERE published = 1 AND featured = 1
        ORDER BY created_at DESC
        LIMIT 6
    `).all().map(parseProduct).map((product) => hydrateProduct(db, product));
}

function listAdminProducts(db) {
    return db.prepare(`
        SELECT *
        FROM products
        ORDER BY created_at DESC
    `).all().map(parseProduct).map((product) => hydrateProduct(db, product));
}

function listProductCategories(db, options = {}) {
    const conditions = options.publishedOnly ? "WHERE published = 1" : "";

    return uniqueStrings(db.prepare(`
        SELECT *
        FROM products
        ${conditions}
    `).all()
        .map(parseProduct)
        .flatMap((product) => product.categories || []))
        .sort((left, right) => left.localeCompare(right, "fr", { sensitivity: "base" }));
}

function listAdminCategories(db) {
    const categoryMap = new Map();

    db.prepare(`
        SELECT *
        FROM products
        ORDER BY created_at DESC
    `).all()
        .map(parseProduct)
        .forEach((product) => {
            for (const category of product.categories || []) {
                const key = category.toLocaleLowerCase("fr-CH");
                const current = categoryMap.get(key) || {
                    name: category,
                    product_count: 0,
                    published_product_count: 0,
                };
                current.product_count += 1;
                if (product.published) {
                    current.published_product_count += 1;
                }
                categoryMap.set(key, current);
            }
        });

    return [...categoryMap.values()]
        .sort((left, right) => left.name.localeCompare(right.name, "fr", { sensitivity: "base" }));
}

function deleteProductCategory(db, categoryName) {
    const normalizedCategory = String(categoryName || "").trim().toLocaleLowerCase("fr-CH");
    if (!normalizedCategory) {
        return { updatedProducts: 0 };
    }

    const products = db.prepare(`
        SELECT *
        FROM products
    `).all().map(parseProduct);
    const updateProductCategories = db.prepare(`
        UPDATE products
        SET category = ?,
            categories_json = ?,
            updated_at = ?
        WHERE id = ?
    `);
    let updatedProducts = 0;

    const transaction = db.transaction(() => {
        for (const product of products) {
            const nextCategories = (product.categories || [])
                .filter((category) => category.toLocaleLowerCase("fr-CH") !== normalizedCategory);

            if (nextCategories.length === (product.categories || []).length) {
                continue;
            }

            updatedProducts += 1;
            updateProductCategories.run(
                nextCategories[0] || "",
                JSON.stringify(nextCategories),
                nowIso(),
                product.id
            );
        }
    });

    transaction();
    return { updatedProducts };
}

function getProductBySlug(db, slug) {
    const product = parseProduct(db.prepare("SELECT * FROM products WHERE slug = ?").get(slug));
    return hydrateProduct(db, product);
}

function getProductById(db, productId) {
    const product = parseProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(productId));
    return hydrateProduct(db, product);
}

function getAdminByUsername(db, username) {
    return db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
}

function getAdminById(db, adminId) {
    return db.prepare("SELECT id, username, role, created_at FROM admins WHERE id = ?").get(adminId);
}

function listAdmins(db) {
    return db.prepare(`
        SELECT id, username, role, created_at
        FROM admins
        ORDER BY created_at ASC, id ASC
    `).all();
}

function countAdminsByRole(db, role) {
    return db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role = ?").get(role).count;
}

function createAdmin(db, input) {
    const timestamp = nowIso();
    const result = db.prepare(`
        INSERT INTO admins (username, password_hash, role, created_at)
        VALUES (?, ?, ?, ?)
    `).run(input.username, hashPassword(input.password), input.role || "admin", timestamp);

    return getAdminById(db, result.lastInsertRowid);
}

function updateAdmin(db, adminId, input) {
    const existing = getAdminById(db, adminId);
    if (!existing) {
        return null;
    }

    const nextPasswordHash = input.password ? hashPassword(input.password) : db.prepare(
        "SELECT password_hash FROM admins WHERE id = ?"
    ).get(adminId).password_hash;

    db.prepare(`
        UPDATE admins
        SET username = ?,
            password_hash = ?,
            role = ?
        WHERE id = ?
    `).run(input.username, nextPasswordHash, input.role || existing.role, adminId);

    return getAdminById(db, adminId);
}

function deleteAdmin(db, adminId) {
    return db.prepare("DELETE FROM admins WHERE id = ?").run(adminId).changes > 0;
}

function parseSiteReview(review) {
    if (!review) {
        return null;
    }

    return {
        ...review,
        rating: Math.min(5, Math.max(1, Number.parseInt(review.rating, 10) || 1)),
        approved: review.approved === 1,
    };
}

function listApprovedSiteReviews(db) {
    return db.prepare(`
        SELECT *
        FROM site_reviews
        WHERE approved = 1
        ORDER BY created_at DESC, id DESC
    `).all().map(parseSiteReview);
}

function getSiteReviewSummary(db) {
    const summary = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(AVG(rating), 0) AS average_rating
        FROM site_reviews
        WHERE approved = 1
    `).get();

    return {
        count: summary.count,
        averageRating: Number(summary.average_rating || 0),
    };
}

function listPendingSiteReviews(db) {
    return db.prepare(`
        SELECT *
        FROM site_reviews
        WHERE approved = 0
        ORDER BY created_at ASC, id ASC
    `).all().map(parseSiteReview);
}

function countPendingSiteReviews(db) {
    return db.prepare("SELECT COUNT(*) AS count FROM site_reviews WHERE approved = 0").get().count;
}

function createSiteReview(db, input) {
    const timestamp = nowIso();
    const result = db.prepare(`
        INSERT INTO site_reviews (
            rating, reviewer_name, reviewer_email, title, body, approved, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
        input.rating,
        input.reviewer_name,
        input.reviewer_email || "",
        input.title || "",
        input.body,
        timestamp,
        timestamp
    );

    return parseSiteReview(db.prepare("SELECT * FROM site_reviews WHERE id = ?").get(result.lastInsertRowid));
}

function approveSiteReview(db, reviewId) {
    db.prepare(`
        UPDATE site_reviews
        SET approved = 1,
            updated_at = ?
        WHERE id = ?
    `).run(nowIso(), reviewId);

    return parseSiteReview(db.prepare("SELECT * FROM site_reviews WHERE id = ?").get(reviewId));
}

function deleteSiteReview(db, reviewId) {
    return db.prepare("DELETE FROM site_reviews WHERE id = ?").run(reviewId).changes > 0;
}

function parsePromoCode(promoCode) {
    if (!promoCode) {
        return null;
    }

    const discountValue = Number(promoCode.discount_value || 0);

    return {
        ...promoCode,
        code: normalizePromoCodeValue(promoCode.code),
        active: promoCode.active === 1,
        discount_percent: promoCode.discount_type === "percent" ? discountValue : null,
        discount_cents: promoCode.discount_type === "fixed" ? discountValue : null,
    };
}

function listPromoCodes(db) {
    return db.prepare(`
        SELECT *
        FROM promo_codes
        ORDER BY created_at DESC, id DESC
    `).all().map(parsePromoCode);
}

function getPromoCodeById(db, promoCodeId) {
    return parsePromoCode(db.prepare("SELECT * FROM promo_codes WHERE id = ?").get(promoCodeId));
}

function getPromoCodeByCode(db, code) {
    return parsePromoCode(
        db.prepare("SELECT * FROM promo_codes WHERE code = ?").get(normalizePromoCodeValue(code))
    );
}

function createPromoCode(db, input) {
    const timestamp = nowIso();
    const result = db.prepare(`
        INSERT INTO promo_codes (
            code,
            description,
            discount_type,
            discount_value,
            minimum_order_cents,
            max_redemptions,
            times_redeemed,
            starts_on,
            expires_on,
            active,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        normalizePromoCodeValue(input.code),
        input.description || "",
        input.discount_type,
        input.discount_value,
        input.minimum_order_cents || 0,
        input.max_redemptions ?? null,
        input.times_redeemed || 0,
        input.starts_on || null,
        input.expires_on || null,
        input.active ? 1 : 0,
        timestamp,
        timestamp
    );

    return getPromoCodeById(db, result.lastInsertRowid);
}

function updatePromoCode(db, promoCodeId, input) {
    const existing = getPromoCodeById(db, promoCodeId);
    if (!existing) {
        return null;
    }

    db.prepare(`
        UPDATE promo_codes
        SET code = ?,
            description = ?,
            discount_type = ?,
            discount_value = ?,
            minimum_order_cents = ?,
            max_redemptions = ?,
            starts_on = ?,
            expires_on = ?,
            active = ?,
            updated_at = ?
        WHERE id = ?
    `).run(
        normalizePromoCodeValue(input.code),
        input.description || "",
        input.discount_type,
        input.discount_value,
        input.minimum_order_cents || 0,
        input.max_redemptions ?? null,
        input.starts_on || null,
        input.expires_on || null,
        input.active ? 1 : 0,
        nowIso(),
        promoCodeId
    );

    return getPromoCodeById(db, promoCodeId);
}

function deletePromoCode(db, promoCodeId) {
    return db.prepare("DELETE FROM promo_codes WHERE id = ?").run(promoCodeId).changes > 0;
}

function getOrderReceivedAmountCents(order) {
    const receivedAmountCents = Number.parseInt(order?.metadata?.payment?.received_amount_cents, 10);
    return Number.isInteger(receivedAmountCents) && receivedAmountCents >= 0
        ? receivedAmountCents
        : null;
}

function getOrderRevenueAmountCents(order) {
    return getOrderReceivedAmountCents(order) ?? order.amount_cents ?? 0;
}

function getDashboardStats(db) {
    const products = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;
    const publishedProducts = db.prepare("SELECT COUNT(*) AS count FROM products WHERE published = 1").get().count;
    const paidOrderRows = db.prepare("SELECT * FROM orders WHERE status = 'paid'").all().map(parseOrder);
    const paidOrders = paidOrderRows.length;
    const revenueCents = paidOrderRows.reduce((total, order) => total + getOrderRevenueAmountCents(order), 0);
    const activePromoCodes = db.prepare("SELECT COUNT(*) AS count FROM promo_codes WHERE active = 1").get().count;
    const pendingReviews = countPendingSiteReviews(db);
    const potentialRevenueCents = listAdminProducts(db)
        .filter((product) => !product.is_pack)
        .reduce((total, product) => {
        const configurationRevenueCents = (product.valid_configurations || []).reduce((configurationTotal, configuration) => {
            const quantity = Number.isInteger(configuration.quantity) ? configuration.quantity : 0;
            const unitPriceCents = configuration.price_cents ?? product.price_cents;
            return configurationTotal + (quantity * unitPriceCents);
        }, 0);
        const reservedConfigurationStock = (product.valid_configurations || []).reduce((configurationStock, configuration) => (
            configurationStock + (Number.isInteger(configuration.quantity) ? configuration.quantity : 0)
        ), 0);
        const remainingGlobalStock = Math.max((product.inventory || 0) - reservedConfigurationStock, 0);

            return total + configurationRevenueCents + (remainingGlobalStock * product.price_cents);
        }, 0);

    return {
        products,
        publishedProducts,
        paidOrders,
        revenueCents,
        activePromoCodes,
        pendingReviews,
        potentialRevenueCents,
    };
}

function createOrder(db, input) {
    const orderNumber = `RCT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const timestamp = nowIso();
    const createdAt = input.created_at || timestamp;

    const result = db.prepare(`
        INSERT INTO orders (
            order_number, provider, provider_reference, status,
            customer_name, customer_email, amount_cents, currency,
            items_json, metadata_json, created_at, updated_at
        )
        VALUES (
            @order_number, @provider, @provider_reference, @status,
            @customer_name, @customer_email, @amount_cents, @currency,
            @items_json, @metadata_json, @created_at, @updated_at
        )
    `).run({
        order_number: orderNumber,
        provider: input.provider,
        provider_reference: input.provider_reference || null,
        status: input.status || "pending",
        customer_name: input.customer_name,
        customer_email: input.customer_email,
        amount_cents: input.amount_cents,
        currency: input.currency || "CHF",
        items_json: JSON.stringify(input.items),
        metadata_json: JSON.stringify(input.metadata || {}),
        created_at: createdAt,
        updated_at: timestamp,
    });

    return getOrderById(db, result.lastInsertRowid);
}

function listRecentOrders(db) {
    return db.prepare(`
        SELECT *
        FROM orders
        ORDER BY created_at DESC
        LIMIT 10
    `).all().map(parseOrder);
}

function listOrders(db, filters = {}) {
    const conditions = [];
    const values = [];

    if (filters.status) {
        conditions.push("status = ?");
        values.push(filters.status);
    }

    if (filters.query) {
        conditions.push("(order_number LIKE ? OR customer_name LIKE ? OR customer_email LIKE ?)");
        const pattern = `%${filters.query}%`;
        values.push(pattern, pattern, pattern);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    return db.prepare(`
        SELECT *
        FROM orders
        ${whereClause}
        ORDER BY created_at DESC
    `).all(...values).map(parseOrder);
}

function deleteOrder(db, orderId) {
    return db.prepare("DELETE FROM orders WHERE id = ?").run(orderId).changes > 0;
}

function parseOrder(order) {
    if (!order) {
        return null;
    }

    return {
        ...order,
        items: JSON.parse(order.items_json || "[]"),
        metadata: JSON.parse(order.metadata_json || "{}"),
    };
}

function getOrderById(db, orderId) {
    return parseOrder(db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId));
}

function getOrderByNumber(db, orderNumber) {
    return parseOrder(db.prepare("SELECT * FROM orders WHERE order_number = ?").get(orderNumber));
}

function getOrderByProviderReference(db, provider, providerReference) {
    return parseOrder(
        db.prepare("SELECT * FROM orders WHERE provider = ? AND provider_reference = ?").get(provider, providerReference)
    );
}

function updateOrderProviderReference(db, orderId, providerReference, metadata = null) {
    const current = getOrderById(db, orderId);
    if (!current) {
        return null;
    }

    const nextMetadata = metadata ? { ...current.metadata, ...metadata } : current.metadata;

    db.prepare(`
        UPDATE orders
        SET provider_reference = ?,
            metadata_json = ?,
            updated_at = ?
        WHERE id = ?
    `).run(providerReference, JSON.stringify(nextMetadata), nowIso(), orderId);

    return getOrderById(db, orderId);
}

function updateOrderStatus(db, orderId, status, metadata = null) {
    const current = getOrderById(db, orderId);
    if (!current) {
        return null;
    }

    const nextMetadata = metadata ? { ...current.metadata, ...metadata } : current.metadata;

    db.prepare(`
        UPDATE orders
        SET status = ?,
            metadata_json = ?,
            updated_at = ?
        WHERE id = ?
    `).run(status, JSON.stringify(nextMetadata), nowIso(), orderId);

    return getOrderById(db, orderId);
}

function updateOrderRecord(db, orderId, updates = {}) {
    const current = getOrderById(db, orderId);
    if (!current) {
        return null;
    }

    const nextStatus = updates.status || current.status;
    const nextMetadata = updates.metadata
        ? { ...current.metadata, ...updates.metadata }
        : current.metadata;
    const nextCreatedAt = updates.created_at || current.created_at;

    db.prepare(`
        UPDATE orders
        SET status = ?,
            metadata_json = ?,
            created_at = ?,
            updated_at = ?
        WHERE id = ?
    `).run(nextStatus, JSON.stringify(nextMetadata), nextCreatedAt, nowIso(), orderId);

    return getOrderById(db, orderId);
}

function markOrderPaid(db, orderId, metadata = null) {
    const order = getOrderById(db, orderId);
    if (!order || order.status === "paid") {
        return order;
    }

    const promoCodeId = Number.parseInt(order.metadata?.promo?.id, 10);
    const timestamp = nowIso();
    const paymentAlreadyRecorded = Boolean(order.metadata?.payment_recorded_at);
    const nextMetadata = {
        ...(metadata ? { ...order.metadata, ...metadata } : order.metadata),
        payment_recorded_at: order.metadata?.payment_recorded_at || timestamp,
    };
    const today = timestamp.slice(0, 10);

    const transaction = db.transaction(() => {
        const nextItems = (order.items || []).map((item) => ({
            ...item,
            service_tags: Array.isArray(item.service_tags)
                ? uniqueStrings(item.service_tags.map((tag) => String(tag || "").trim()))
                : [],
        }));
        const updateInventory = db.prepare(`
            UPDATE products
            SET inventory = inventory - ?,
                updated_at = ?
            WHERE id = ?
              AND inventory >= ?
        `);
        const updateConfigurations = db.prepare(`
            UPDATE products
            SET valid_configurations_json = ?,
                updated_at = ?
            WHERE id = ?
        `);
        const productsToUpdate = new Map();

        function getMutableProduct(productId) {
            let product = productsToUpdate.get(productId);
            if (product) {
                return product;
            }

            const record = getProductById(db, productId);
            if (!record) {
                return null;
            }

            product = {
                ...record,
                valid_configurations: (record.valid_configurations || []).map((configuration) => ({
                    ...configuration,
                    selections: getConfigurationSelections(configuration).map((selection) => ({ ...selection })),
                    service_tags: Array.isArray(configuration.service_tags) ? [...configuration.service_tags] : [],
                })),
                bundle_items: (record.bundle_items || []).map((bundleItem) => ({
                    ...bundleItem,
                    selected_options: (bundleItem.selected_options || []).map((option) => ({ ...option })),
                })),
            };

            productsToUpdate.set(productId, product);
            return product;
        }

        function consumeProductQuantity(productId, itemName, quantity, selectedOptions = [], requestedServiceTags = []) {
            const product = getMutableProduct(productId);
            if (!product) {
                return { serviceTags: [] };
            }

            const availableQuantity = getConfigurationAvailableQuantity(product, selectedOptions);
            if (quantity > availableQuantity) {
                throw new Error(`Stock insuffisant pour ${itemName}. La commande ne peut pas être finalisée.`);
            }

            const inventoryUpdate = updateInventory.run(quantity, timestamp, productId, quantity);
            if (!inventoryUpdate.changes) {
                throw new Error(`Stock insuffisant pour ${itemName}. La commande ne peut pas être finalisée.`);
            }

            const configuration = (product.valid_configurations || []).find((candidate) => {
                const selections = getConfigurationSelections(candidate);
                return selections.length === selectedOptions.length && selections.every((selection, index) =>
                    selection.name === selectedOptions[index]?.name && selection.value === selectedOptions[index]?.value
                );
            });

            if (!configuration) {
                return { serviceTags: [] };
            }

            if (Number.isInteger(configuration.quantity)) {
                configuration.quantity = Math.max(configuration.quantity - quantity, 0);
            }

            if (!Array.isArray(configuration.service_tags) || !configuration.service_tags.length) {
                return { serviceTags: [] };
            }

            const normalizedRequestedTags = Array.isArray(requestedServiceTags)
                ? uniqueStrings(requestedServiceTags.map((tag) => String(tag || "").trim()))
                : [];
            const unavailableRequestedTags = normalizedRequestedTags.filter((tag) => !configuration.service_tags.includes(tag));

            if (unavailableRequestedTags.length) {
                throw new Error("Un ou plusieurs tags de service ne sont plus disponibles pour cette commande.");
            }

            const requestedTagSet = new Set(normalizedRequestedTags);
            const remainingConfigurationTags = configuration.service_tags.filter((tag) => !requestedTagSet.has(tag));
            const missingCount = Math.max(quantity - normalizedRequestedTags.length, 0);
            const autoAssignedTags = missingCount > 0
                ? remainingConfigurationTags.slice(0, missingCount)
                : [];
            const consumedTags = [...normalizedRequestedTags, ...autoAssignedTags].slice(0, quantity);
            const consumedTagSet = new Set(consumedTags);

            configuration.service_tags = configuration.service_tags.filter((tag) => !consumedTagSet.has(tag));
            if (!Number.isInteger(configuration.quantity)) {
                configuration.quantity = configuration.service_tags.length;
            }

            return { serviceTags: consumedTags };
        }

        if (!paymentAlreadyRecorded) {
            for (const item of nextItems) {
                if (item.is_pack && Array.isArray(item.bundle_items) && item.bundle_items.length) {
                    item.bundle_items = item.bundle_items.map((bundleItem) => {
                        const selectedOptions = Array.isArray(bundleItem.selected_options) ? bundleItem.selected_options : [];
                        const componentQuantity = Math.max(1, Number.parseInt(bundleItem.quantity, 10) || 1) * item.quantity;
                        const result = consumeProductQuantity(
                            bundleItem.product_id,
                            `${item.name} · ${bundleItem.name}`,
                            componentQuantity,
                            selectedOptions,
                            bundleItem.service_tags
                        );

                        return {
                            ...bundleItem,
                            selected_options: selectedOptions,
                            service_tags: result.serviceTags,
                        };
                    });
                    continue;
                }

                const selectedOptions = Array.isArray(item.selected_options) ? item.selected_options : [];
                const result = consumeProductQuantity(
                    item.product_id,
                    item.name,
                    item.quantity,
                    selectedOptions,
                    item.service_tags
                );
                item.service_tags = result.serviceTags;
            }

            for (const product of productsToUpdate.values()) {
                updateConfigurations.run(JSON.stringify(product.valid_configurations || []), timestamp, product.id);
            }
        }

        db.prepare(`
            UPDATE orders
            SET status = 'paid',
                metadata_json = ?,
                items_json = ?,
                updated_at = ?
            WHERE id = ?
        `).run(JSON.stringify(nextMetadata), JSON.stringify(nextItems), timestamp, orderId);

        if (!paymentAlreadyRecorded && Number.isInteger(promoCodeId) && promoCodeId > 0) {
            const promoCodeUpdate = db.prepare(`
                UPDATE promo_codes
                SET times_redeemed = times_redeemed + 1,
                    updated_at = ?
                WHERE id = ?
                  AND active = 1
                  AND (starts_on IS NULL OR starts_on = '' OR starts_on <= ?)
                  AND (expires_on IS NULL OR expires_on = '' OR expires_on >= ?)
                  AND (max_redemptions IS NULL OR max_redemptions <= 0 OR times_redeemed < max_redemptions)
            `).run(timestamp, promoCodeId, today, today);

            if (!promoCodeUpdate.changes) {
                throw new Error("Le code promo lié à cette commande n'est plus valide ou a atteint sa limite d'utilisation.");
            }
        }
    });

    transaction();

    return getOrderById(db, orderId);
}

module.exports = {
    DEFAULT_SETTINGS,
    initializeDatabase,
    getSettings,
    saveSettings,
    createProduct,
    updateProduct,
    deleteProduct,
    listPacksContainingProduct,
    listPublishedProducts,
    listFeaturedProducts,
    listAdminProducts,
    listProductCategories,
    listAdminCategories,
    deleteProductCategory,
    getProductBySlug,
    getProductById,
    getAdminByUsername,
    getAdminById,
    listAdmins,
    countAdminsByRole,
    createAdmin,
    updateAdmin,
    deleteAdmin,
    listApprovedSiteReviews,
    getSiteReviewSummary,
    listPendingSiteReviews,
    countPendingSiteReviews,
    createSiteReview,
    approveSiteReview,
    deleteSiteReview,
    listPromoCodes,
    getPromoCodeById,
    getPromoCodeByCode,
    createPromoCode,
    updatePromoCode,
    deletePromoCode,
    getDashboardStats,
    createOrder,
    getOrderById,
    getOrderByNumber,
    getOrderByProviderReference,
    updateOrderProviderReference,
    updateOrderStatus,
    updateOrderRecord,
    markOrderPaid,
    listRecentOrders,
    listOrders,
    deleteOrder,
};
