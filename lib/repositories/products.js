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
} = require("../product-normalizers");
const { parseInteger, parseMoneyToCents } = require("../input-utils");

const PRODUCT_NAME_MAX_LENGTH = 160;

const PRODUCT_DETAIL_COLUMNS = `
    id, slug, product_kind, name, category, categories_json, short_description, description, admin_notes, image_url,
    image_gallery_json, option_groups_json, info_rows_json, valid_configurations_json, bundle_items_json,
    price_cents, starting_price_cents, maximum_price_cents, currency, inventory, featured, published,
    created_at, updated_at
`;

function nowIso() {
    return new Date().toISOString();
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

function inventoryModelSignature(productKind, configurations = []) {
    const configurationKeys = configurations
        .map((configuration) => JSON.stringify((configuration.selections || []).map((selection) => ({
            name: selection.name,
            value: selection.value,
        }))))
        .sort();

    return JSON.stringify({ productKind, configurationKeys });
}

function getProductPriceRangeCents(product) {
    const basePriceCents = Math.max(0, Number.parseInt(product.price_cents, 10) || 0);
    const configurationPrices = (product.valid_configurations || [])
        .map((configuration) => Number.isInteger(configuration.price_cents) ? configuration.price_cents : basePriceCents)
        .filter((priceCents) => Number.isInteger(priceCents) && priceCents >= 0);

    if (!configurationPrices.length) {
        return {
            starting_price_cents: basePriceCents,
            maximum_price_cents: basePriceCents,
        };
    }

    return {
        starting_price_cents: Math.min(...configurationPrices),
        maximum_price_cents: Math.max(...configurationPrices),
    };
}

function parseStoredCategories(row) {
    const categories = [];

    try {
        const parsed = JSON.parse(row?.categories_json || "[]");
        if (Array.isArray(parsed)) {
            categories.push(...parsed);
        }
    } catch {
        // Fall back to the legacy category column below.
    }

    if (row?.category) {
        categories.push(row.category);
    }

    return uniqueStrings(categories
        .map((category) => String(category || "").trim())
        .filter(Boolean));
}

function normalizeCategoryKey(value) {
    return String(value || "").trim().toLocaleLowerCase("fr-CH");
}

function syncProductCategories(db, productId, categories) {
    const deleteCategories = db.prepare("DELETE FROM product_categories WHERE product_id = ?");
    const insertCategory = db.prepare(`
        INSERT INTO product_categories (product_id, category, category_key, position)
        VALUES (?, ?, ?, ?)
    `);

    const seenKeys = new Set();
    const normalizedCategories = categories.filter((category) => {
        const categoryKey = normalizeCategoryKey(category);
        if (!categoryKey || seenKeys.has(categoryKey)) {
            return false;
        }

        seenKeys.add(categoryKey);
        return true;
    });

    deleteCategories.run(productId);
    normalizedCategories.forEach((category, index) => {
        insertCategory.run(productId, category, normalizeCategoryKey(category), index);
    });
}

function parseAdminProductRow(row) {
    if (!row) {
        return null;
    }

    const categories = parseStoredCategories(row);
    return {
        ...row,
        is_pack: row.product_kind === "pack",
        category: categories[0] || "",
        categories,
    };
}

function parseStoredBundleItems(row) {
    try {
        const parsed = JSON.parse(row?.bundle_items_json || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
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
    const name = String(input.name || "").trim().replace(/[\r\n]+/g, " ");
    const rawPrice = String(input.price_chf ?? "").trim();
    const priceCents = rawPrice ? parseMoneyToCents(rawPrice, Number.NaN) : 0;
    const rawInventory = String(input.inventory ?? "").trim();
    const inventory = rawInventory ? parseInteger(rawInventory, Number.NaN) : 0;

    if (!name) {
        throw new Error("Le nom du produit est obligatoire.");
    }

    if (name.length > PRODUCT_NAME_MAX_LENGTH) {
        throw new Error(`Le nom du produit ne peut pas dépasser ${PRODUCT_NAME_MAX_LENGTH} caractères.`);
    }

    if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
        throw new Error("Le prix du produit est invalide.");
    }

    if (!Number.isSafeInteger(inventory) || inventory < 0) {
        throw new Error("Le stock du produit est invalide.");
    }

    if (productKind === "pack") {
        if (String(input.option_groups || "").trim()) {
            throw new Error("Un pack ne peut pas définir ses propres options.");
        }

        if (String(input.valid_configurations || "").trim()) {
            throw new Error("Un pack ne peut pas définir ses propres combinaisons autorisées.");
        }
    }

    const product = {
        product_kind: productKind,
        name,
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
        price_cents: priceCents,
        currency: "CHF",
        inventory: productKind === "pack" ? 0 : inventory,
        featured: input.featured ? 1 : 0,
        published: input.published ? 1 : 0,
    };

    return {
        ...product,
        ...getProductPriceRangeCents({
            price_cents: product.price_cents,
            valid_configurations: validConfigurations,
        }),
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

    const transaction = db.transaction(() => {
        const result = db.prepare(`
            INSERT INTO products (
                slug, product_kind, name, category, categories_json, short_description, description, admin_notes, image_url,
                image_gallery_json, option_groups_json, info_rows_json, valid_configurations_json,
                bundle_items_json,
                price_cents, starting_price_cents, maximum_price_cents, currency, inventory, featured, published,
                created_at, updated_at
            )
            VALUES (
                @slug, @product_kind, @name, @category, @categories_json, @short_description, @description, @admin_notes, @image_url,
                @image_gallery_json, @option_groups_json, @info_rows_json, @valid_configurations_json,
                @bundle_items_json,
                @price_cents, @starting_price_cents, @maximum_price_cents, @currency, @inventory, @featured, @published,
                @created_at, @updated_at
            )
        `).run({
            ...product,
            bundle_items_json: JSON.stringify(bundleItems),
            slug,
            created_at: timestamp,
            updated_at: timestamp,
        });
        syncProductCategories(db, result.lastInsertRowid, parseStoredCategories(product));

        return result.lastInsertRowid;
    });

    return getProductById(db, transaction());
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
    const nextInventoryModelSignature = inventoryModelSignature(
        product.product_kind,
        JSON.parse(product.valid_configurations_json)
    );

    const transaction = db.transaction(() => {
        const current = getProductById(db, productId);
        if (!current) {
            return false;
        }

        const inventoryModelChanged = inventoryModelSignature(
            current.product_kind,
            current.valid_configurations
        ) !== nextInventoryModelSignature;
        if (inventoryModelChanged && hasActiveProductReservation(db, productId)) {
            throw new Error("Le modèle de stock de ce produit ne peut pas être modifié pendant une réservation active.");
        }

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
                starting_price_cents = @starting_price_cents,
                maximum_price_cents = @maximum_price_cents,
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
        syncProductCategories(db, productId, parseStoredCategories(product));
        return true;
    });
    if (!transaction.immediate()) {
        return null;
    }

    return getProductById(db, productId);
}

function hasActiveProductReservation(db, productId) {
    return Boolean(db.prepare(`
        SELECT orders.id
        FROM orders
        WHERE json_extract(orders.metadata_json, '$.inventory_reserved_at') IS NOT NULL
          AND json_extract(orders.metadata_json, '$.inventory_released_at') IS NULL
          AND json_extract(orders.metadata_json, '$.payment_recorded_at') IS NULL
          AND EXISTS (
              SELECT 1
              FROM json_each(orders.items_json) AS order_item
              WHERE CAST(json_extract(order_item.value, '$.product_id') AS INTEGER) = ?
                 OR EXISTS (
                     SELECT 1
                     FROM json_each(COALESCE(json_extract(order_item.value, '$.bundle_items'), '[]')) AS bundle_item
                     WHERE CAST(json_extract(bundle_item.value, '$.product_id') AS INTEGER) = ?
                 )
          )
        LIMIT 1
    `).get(productId, productId));
}

function deleteProduct(db, productId) {
    return db.transaction(() => {
        if (hasActiveProductReservation(db, productId)) {
            throw new Error("Ce produit est réservé par une commande en cours et ne peut pas être supprimé.");
        }

        db.prepare("DELETE FROM product_categories WHERE product_id = ?").run(productId);
        return db.prepare("DELETE FROM products WHERE id = ?").run(productId);
    }).immediate();
}

function listPacksContainingProduct(db, productId) {
    return db.prepare(`
        SELECT id, name, bundle_items_json
        FROM products
        WHERE product_kind = 'pack'
    `).all()
        .filter((product) => parseStoredBundleItems(product).some((item) => item.product_id === productId));
}

function matchesAvailability(product, availability) {
    if (availability === "in_stock") {
        return product.inventory > 0;
    }

    if (availability === "out_of_stock") {
        return product.inventory <= 0;
    }

    return true;
}

function hydratePublishedProductRows(db, rows, cache = new Map()) {
    return rows.map(parseProduct).map((product) => hydrateProduct(db, product, cache));
}

function listPublishedProductsWithHydratedAvailability(db, sql, values, filters, limit, offset) {
    const matches = [];
    const targetCount = offset + limit;
    const batchSize = Math.min(Math.max(targetCount * 2, 50), 500);
    const hydrationCache = new Map();
    let candidateOffset = 0;

    while (matches.length < targetCount) {
        const rows = db.prepare(sql).all(...values, batchSize, candidateOffset);
        if (!rows.length) {
            break;
        }

        matches.push(...hydratePublishedProductRows(db, rows, hydrationCache)
            .filter((product) => matchesAvailability(product, filters.availability)));
        candidateOffset += rows.length;

        if (rows.length < batchSize) {
            break;
        }
    }

    return matches.slice(offset, offset + limit);
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
    if (category) {
        conditions.push(`(
            EXISTS (
                SELECT 1
                FROM product_categories
                WHERE product_categories.product_id = products.id
                  AND product_categories.category_key = ?
            )
            OR LOWER(category) = LOWER(?)
        )`);
        values.push(normalizeCategoryKey(category), category);
    }

    if (filters.availability === "in_stock") {
        conditions.push("(product_kind = 'pack' OR inventory > 0)");
    } else if (filters.availability === "out_of_stock") {
        conditions.push("(product_kind = 'pack' OR inventory <= 0)");
    }

    if (Number.isFinite(filters.minPriceCents)) {
        conditions.push("maximum_price_cents >= ?");
        values.push(filters.minPriceCents);
    }

    if (Number.isFinite(filters.maxPriceCents)) {
        conditions.push("starting_price_cents <= ?");
        values.push(filters.maxPriceCents);
    }

    const randomSeed = Math.floor(Date.now() / (1000 * 60 * 30));
    const sqlOrderBy = {
        random: `((id * 1103515245 + ${randomSeed}) & 2147483647) ASC`,
        name_asc: "LOWER(name) ASC, created_at DESC",
        newest: "created_at DESC",
        price_asc: "starting_price_cents ASC, featured DESC, created_at DESC",
        price_desc: "starting_price_cents DESC, featured DESC, created_at DESC",
    }[filters.sort] || "featured DESC, created_at DESC";
    const limit = Math.min(Math.max(Number.parseInt(filters.limit || "120", 10) || 120, 1), 240);
    const offset = Math.max(Number.parseInt(filters.offset || "0", 10) || 0, 0);

    const sql = `
        SELECT ${PRODUCT_DETAIL_COLUMNS}
        FROM products
        WHERE ${conditions.join(" AND ")}
        ORDER BY ${sqlOrderBy}
        LIMIT ?
        OFFSET ?
    `;

    if (filters.availability === "in_stock" || filters.availability === "out_of_stock") {
        return listPublishedProductsWithHydratedAvailability(db, sql, values, filters, limit, offset);
    }

    return hydratePublishedProductRows(db, db.prepare(sql).all(...values, limit, offset));
}

function listAdminProducts(db, options = {}) {
    const limit = Math.min(Math.max(Number.parseInt(options.limit || "500", 10) || 500, 1), 1000);
    const offset = Math.max(Number.parseInt(options.offset || "0", 10) || 0, 0);

    const rows = db.prepare(`
        SELECT id, slug, product_kind, name, category, categories_json, short_description, image_url,
               option_groups_json, valid_configurations_json, bundle_items_json,
               price_cents, starting_price_cents, maximum_price_cents, currency, inventory,
               published, created_at, updated_at
        FROM products
        ORDER BY created_at DESC
        LIMIT ?
        OFFSET ?
    `).all(limit, offset);

    return hydratePublishedProductRows(db, rows);
}

function listAdminProductRows(db, options = {}) {
    const limit = Math.min(Math.max(Number.parseInt(options.limit || "500", 10) || 500, 1), 1000);
    const offset = Math.max(Number.parseInt(options.offset || "0", 10) || 0, 0);

    return db.prepare(`
        SELECT id, product_kind, name, category, categories_json, admin_notes,
               price_cents, currency, inventory, published, created_at
        FROM products
        ORDER BY created_at DESC
        LIMIT ?
        OFFSET ?
    `).all(limit, offset).map(parseAdminProductRow);
}

function listProductCategories(db, options = {}) {
    const conditions = options.publishedOnly ? "WHERE products.published = 1" : "";

    const normalizedCategories = db.prepare(`
        SELECT product_categories.category
        FROM product_categories
        JOIN products ON products.id = product_categories.product_id
        ${conditions}
        ORDER BY product_categories.position ASC
    `).all().map((row) => row.category);

    return uniqueStrings(normalizedCategories)
        .sort((left, right) => left.localeCompare(right, "fr", { sensitivity: "base" }));
}

function listAdminCategories(db) {
    const categoryMap = new Map();

    db.prepare(`
        SELECT product_categories.category, product_categories.category_key, products.published
        FROM product_categories
        JOIN products ON products.id = product_categories.product_id
        ORDER BY products.created_at DESC, product_categories.position ASC
    `).all()
        .forEach((row) => {
            const current = categoryMap.get(row.category_key) || {
                name: row.category,
                product_count: 0,
                published_product_count: 0,
            };
            current.product_count += 1;
            if (row.published) {
                current.published_product_count += 1;
            }
            categoryMap.set(row.category_key, current);
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
        SELECT products.id, products.category, products.categories_json
        FROM products
        WHERE EXISTS (
            SELECT 1
            FROM product_categories
            WHERE product_categories.product_id = products.id
              AND product_categories.category_key = ?
        )
           OR LOWER(products.category) = LOWER(?)
    `).all(normalizedCategory, categoryName);
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
            const categories = parseStoredCategories(product);
            const nextCategories = categories
                .filter((category) => category.toLocaleLowerCase("fr-CH") !== normalizedCategory);

            if (nextCategories.length === categories.length) {
                continue;
            }

            updatedProducts += 1;
            updateProductCategories.run(
                nextCategories[0] || "",
                JSON.stringify(nextCategories),
                nowIso(),
                product.id
            );
            syncProductCategories(db, product.id, nextCategories);
        }
    });

    transaction();
    return { updatedProducts };
}

function getProductBySlug(db, slug) {
    const product = parseProduct(db.prepare(`SELECT ${PRODUCT_DETAIL_COLUMNS} FROM products WHERE slug = ?`).get(slug));
    return hydrateProduct(db, product);
}

function getProductById(db, productId) {
    const product = parseProduct(db.prepare(`SELECT ${PRODUCT_DETAIL_COLUMNS} FROM products WHERE id = ?`).get(productId));
    return hydrateProduct(db, product);
}

module.exports = {
    createProduct,
    updateProduct,
    deleteProduct,
    listPacksContainingProduct,
    listPublishedProducts,
    listAdminProducts,
    listAdminProductRows,
    listProductCategories,
    listAdminCategories,
    deleteProductCategory,
    getProductBySlug,
    getProductById,
    getProductPriceRangeCents,
    hasActiveProductReservation,
    syncProductCategories,
};
