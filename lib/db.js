const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { hashPassword } = require("./auth");

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

function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
}

function parseLineList(value) {
    return String(value || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function parseCategoryList(value) {
    return uniqueStrings(
        String(value || "")
            .split(/[\r\n,]+/)
            .map((item) => item.trim())
            .filter(Boolean)
    );
}

function formatCategoryList(categories) {
    return (categories || []).join("\n");
}

function parseOptionGroups(value) {
    return parseLineList(value)
        .map((line) => {
            const separatorIndex = line.indexOf(":");
            if (separatorIndex === -1) {
                return null;
            }

            const name = line.slice(0, separatorIndex).trim();
            const values = line
                .slice(separatorIndex + 1)
                .split("|")
                .map((item) => item.trim())
                .filter(Boolean);

            if (!name || !values.length) {
                return null;
            }

            return { name, values };
        })
        .filter(Boolean);
}

function parseInfoRows(value) {
    return parseLineList(value)
        .map((line) => {
            const separatorIndex = line.indexOf(":");
            if (separatorIndex === -1) {
                return null;
            }

            const label = line.slice(0, separatorIndex).trim();
            const valueText = line.slice(separatorIndex + 1).trim();

            if (!label || !valueText) {
                return null;
            }

            return { label, value: valueText };
        })
        .filter(Boolean);
}

function parseMoneyToCents(value) {
    const normalized = String(value || "")
        .trim()
        .replace(/^CHF\s*/i, "")
        .replace(/\s*CHF$/i, "")
        .replace(",", ".");

    if (!normalized) {
        return null;
    }

    const amount = Number(normalized);
    if (!Number.isFinite(amount) || amount < 0) {
        return null;
    }

    return Math.round(amount * 100);
}

function splitConfigurationPrice(line) {
    let configurationText = String(line || "").trim();
    let priceCents = null;
    const priceMarkerIndex = configurationText.lastIndexOf("=>");

    if (priceMarkerIndex !== -1) {
        const priceText = configurationText.slice(priceMarkerIndex + 2).trim();
        priceCents = parseMoneyToCents(priceText);
        configurationText = configurationText.slice(0, priceMarkerIndex).trim();

        if (priceCents === null) {
            return null;
        }
    } else {
        const parts = configurationText
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean);
        const lastPart = parts[parts.length - 1] || "";
        const pricePart = lastPart.match(/^(?:prix|price)\s*=\s*(.+)$/i);

        if (pricePart) {
            priceCents = parseMoneyToCents(pricePart[1]);
            parts.pop();
            configurationText = parts.join(" ; ");

            if (priceCents === null) {
                return null;
            }
        }
    }

    if (!configurationText) {
        return null;
    }

    return { configurationText, priceCents };
}

function parseValidConfigurations(value, optionGroups) {
    const groupMap = new Map(optionGroups.map((group) => [group.name, group]));

    return uniqueStrings(parseLineList(value))
        .map((line) => {
            const pricedConfiguration = splitConfigurationPrice(line);
            if (!pricedConfiguration) {
                return null;
            }

            const selections = pricedConfiguration.configurationText
                .split(";")
                .map((part) => part.trim())
                .filter(Boolean)
                .map((part) => {
                    const separatorIndex = part.indexOf("=");
                    if (separatorIndex === -1) {
                        return null;
                    }

                    const name = part.slice(0, separatorIndex).trim();
                    const value = part.slice(separatorIndex + 1).trim();
                    const group = groupMap.get(name);

                    if (!group || !value || !group.values.includes(value)) {
                        return null;
                    }

                    return { name, value };
                });

            if (selections.some((selection) => !selection)) {
                return null;
            }

            if (selections.length !== optionGroups.length) {
                return null;
            }

            const byName = new Map(selections.map((selection) => [selection.name, selection.value]));
            const orderedSelections = optionGroups.map((group) => {
                const value = byName.get(group.name);
                return value ? { name: group.name, value } : null;
            });

            if (orderedSelections.some((selection) => !selection)) {
                return null;
            }

            return {
                selections: orderedSelections,
                price_cents: pricedConfiguration.priceCents,
            };
        })
        .filter(Boolean)
        .filter((configuration, index, configurations) =>
            configurations.findIndex((item) => JSON.stringify(item.selections) === JSON.stringify(configuration.selections)) === index
        );
}

function formatOptionGroups(groups) {
    return (groups || [])
        .map((group) => `${group.name}: ${group.values.join(" | ")}`)
        .join("\n");
}

function formatInfoRows(rows) {
    return (rows || [])
        .map((row) => `${row.label}: ${row.value}`)
        .join("\n");
}

function formatValidConfigurations(configurations) {
    return (configurations || [])
        .map((configuration) => {
            const selections = Array.isArray(configuration)
                ? configuration
                : Array.isArray(configuration?.selections)
                    ? configuration.selections
                    : [];
            const priceCents = Number.isInteger(configuration?.price_cents)
                ? configuration.price_cents
                : null;
            const selectionText = selections.map((selection) => `${selection.name}=${selection.value}`).join(" ; ");

            return priceCents === null
                ? selectionText
                : `${selectionText} => ${(priceCents / 100).toFixed(2)}`;
        })
        .filter(Boolean)
        .join("\n");
}

function parseProduct(product) {
    if (!product) {
        return null;
    }

    const categories = uniqueStrings([
        ...parseJsonArray(product.categories_json).map((value) => String(value || "").trim()),
        String(product.category || "").trim(),
    ]);
    const category = categories[0] || "";
    const image_gallery_urls = uniqueStrings(parseJsonArray(product.image_gallery_json).map((value) => String(value || "").trim()));
    const option_groups = parseJsonArray(product.option_groups_json)
        .map((group) => ({
            name: String(group?.name || "").trim(),
            values: uniqueStrings((Array.isArray(group?.values) ? group.values : []).map((value) => String(value || "").trim())),
        }))
        .filter((group) => group.name && group.values.length);
    const info_rows = parseJsonArray(product.info_rows_json)
        .map((row) => ({
            label: String(row?.label || "").trim(),
            value: String(row?.value || "").trim(),
        }))
        .filter((row) => row.label && row.value);
    const valid_configurations = parseJsonArray(product.valid_configurations_json)
        .map((configuration) => {
            const selectionsSource = Array.isArray(configuration)
                ? configuration
                : Array.isArray(configuration?.selections)
                    ? configuration.selections
                    : [];
            const rawPriceCents = !Array.isArray(configuration) ? configuration?.price_cents : null;
            const priceCents = rawPriceCents === null || rawPriceCents === undefined || rawPriceCents === ""
                ? null
                : Number(rawPriceCents);

            return {
                selections: selectionsSource
                    .map((selection) => ({
                        name: String(selection?.name || "").trim(),
                        value: String(selection?.value || "").trim(),
                    }))
                    .filter((selection) => selection.name && selection.value),
                price_cents: Number.isInteger(priceCents) && priceCents >= 0 ? priceCents : null,
            };
        })
        .filter((configuration) => configuration.selections.length === option_groups.length)
        .filter((configuration) => configuration.selections.every((selection, index) =>
            selection.name === option_groups[index]?.name &&
            option_groups[index]?.values.includes(selection.value)
        ));
    const has_configuration_pricing = valid_configurations.some((configuration) => configuration.price_cents !== null);
    const configurationPrices = valid_configurations.map((configuration) => configuration.price_cents ?? product.price_cents);
    const starting_price_cents = has_configuration_pricing && configurationPrices.length
        ? Math.min(...configurationPrices)
        : product.price_cents;
    const maximum_price_cents = has_configuration_pricing && configurationPrices.length
        ? Math.max(...configurationPrices)
        : product.price_cents;

    return {
        ...product,
        category,
        categories,
        admin_notes: String(product.admin_notes || "").trim(),
        image_gallery_urls,
        gallery_images: uniqueStrings([String(product.image_url || "").trim(), ...image_gallery_urls]),
        option_groups,
        info_rows,
        valid_configurations,
        has_configuration_pricing,
        starting_price_cents,
        maximum_price_cents,
        image_gallery_text: image_gallery_urls.join("\n"),
        categories_text: formatCategoryList(categories),
        option_groups_text: formatOptionGroups(option_groups),
        info_rows_text: formatInfoRows(info_rows),
        valid_configurations_text: formatValidConfigurations(valid_configurations),
    };
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
    `);

    ensureColumn(db, "admins", "role", "TEXT NOT NULL DEFAULT 'admin'");
    ensureColumn(db, "products", "category", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "products", "categories_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "products", "admin_notes", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "products", "image_gallery_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "products", "option_groups_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "products", "info_rows_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(db, "products", "valid_configurations_json", "TEXT NOT NULL DEFAULT '[]'");

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
    const categories = parseCategoryList(input.categories || input.category);
    const imageGallery = uniqueStrings(
        parseLineList(input.image_gallery_urls).filter((url) => url !== primaryImage)
    );
    const optionGroups = parseOptionGroups(input.option_groups);
    const infoRows = parseInfoRows(input.info_rows);
    const validConfigurations = parseValidConfigurations(input.valid_configurations, optionGroups);

    return {
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
        price_cents: Math.round(Number(input.price_chf || 0) * 100),
        currency: "CHF",
        inventory: Math.max(0, Number.parseInt(input.inventory || "0", 10) || 0),
        featured: input.featured ? 1 : 0,
        published: input.published ? 1 : 0,
    };
}

function createProduct(db, input) {
    const product = normalizeProductInput(input);
    const timestamp = nowIso();
    const slug = makeUniqueSlug(db, product.name);

    const result = db.prepare(`
        INSERT INTO products (
            slug, name, category, categories_json, short_description, description, admin_notes, image_url,
            image_gallery_json, option_groups_json, info_rows_json, valid_configurations_json,
            price_cents, currency, inventory, featured, published,
            created_at, updated_at
        )
        VALUES (
            @slug, @name, @category, @categories_json, @short_description, @description, @admin_notes, @image_url,
            @image_gallery_json, @option_groups_json, @info_rows_json, @valid_configurations_json,
            @price_cents, @currency, @inventory, @featured, @published,
            @created_at, @updated_at
        )
    `).run({
        ...product,
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
    const slug = makeUniqueSlug(db, product.name, productId);

    db.prepare(`
        UPDATE products
        SET slug = @slug,
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
            price_cents = @price_cents,
            currency = @currency,
            inventory = @inventory,
            featured = @featured,
            published = @published,
            updated_at = @updated_at
        WHERE id = @id
    `).run({
        ...product,
        slug,
        updated_at: nowIso(),
        id: productId,
    });

    return getProductById(db, productId);
}

function deleteProduct(db, productId) {
    return db.prepare("DELETE FROM products WHERE id = ?").run(productId);
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

    if (filters.availability === "in_stock") {
        conditions.push("inventory > 0");
    } else if (filters.availability === "out_of_stock") {
        conditions.push("inventory <= 0");
    }

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
    `).all(...values).map(parseProduct);

    if (category) {
        const categoryKey = category.toLowerCase();
        products = products.filter((product) =>
            (product.categories || []).some((productCategory) => productCategory.toLowerCase() === categoryKey)
        );
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
    `).all().map(parseProduct);
}

function listAdminProducts(db) {
    return db.prepare(`
        SELECT *
        FROM products
        ORDER BY created_at DESC
    `).all().map(parseProduct);
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

function getProductBySlug(db, slug) {
    return parseProduct(db.prepare("SELECT * FROM products WHERE slug = ?").get(slug));
}

function getProductById(db, productId) {
    return parseProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(productId));
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

function getDashboardStats(db) {
    const products = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;
    const publishedProducts = db.prepare("SELECT COUNT(*) AS count FROM products WHERE published = 1").get().count;
    const paidOrders = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'paid'").get().count;
    const revenueCents = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM orders WHERE status = 'paid'").get().total;
    const activePromoCodes = db.prepare("SELECT COUNT(*) AS count FROM promo_codes WHERE active = 1").get().count;

    return {
        products,
        publishedProducts,
        paidOrders,
        revenueCents,
        activePromoCodes,
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

    const transaction = db.transaction(() => {
        db.prepare(`
            UPDATE orders
            SET status = 'paid',
                metadata_json = ?,
                updated_at = ?
            WHERE id = ?
        `).run(JSON.stringify(nextMetadata), timestamp, orderId);

        const updateInventory = db.prepare(`
            UPDATE products
            SET inventory = MAX(inventory - ?, 0),
                updated_at = ?
            WHERE id = ?
        `);

        if (!paymentAlreadyRecorded) {
            for (const item of order.items) {
                updateInventory.run(item.quantity, timestamp, item.product_id);
            }
        }

        if (!paymentAlreadyRecorded && Number.isInteger(promoCodeId) && promoCodeId > 0) {
            db.prepare(`
                UPDATE promo_codes
                SET times_redeemed = times_redeemed + 1,
                    updated_at = ?
                WHERE id = ?
            `).run(timestamp, promoCodeId);
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
    listPublishedProducts,
    listFeaturedProducts,
    listAdminProducts,
    listProductCategories,
    getProductBySlug,
    getProductById,
    getAdminByUsername,
    getAdminById,
    listAdmins,
    countAdminsByRole,
    createAdmin,
    updateAdmin,
    deleteAdmin,
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
