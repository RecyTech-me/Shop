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

    const product = {
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
    if (category) {
        conditions.push(`(
            EXISTS (
                SELECT 1
                FROM json_each(products.categories_json)
                WHERE LOWER(json_each.value) = LOWER(?)
            )
            OR LOWER(category) = LOWER(?)
        )`);
        values.push(category, category);
    }

    if (filters.availability === "in_stock") {
        conditions.push("inventory > 0");
    } else if (filters.availability === "out_of_stock") {
        conditions.push("inventory <= 0");
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

    const products = db.prepare(`
        SELECT *
        FROM products
        WHERE ${conditions.join(" AND ")}
        ORDER BY ${sqlOrderBy}
        LIMIT ?
        OFFSET ?
    `).all(...values, limit, offset).map(parseProduct).map((product) => hydrateProduct(db, product));

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

function listAdminProducts(db, options = {}) {
    const limit = Math.min(Math.max(Number.parseInt(options.limit || "500", 10) || 500, 1), 1000);
    const offset = Math.max(Number.parseInt(options.offset || "0", 10) || 0, 0);

    return db.prepare(`
        SELECT *
        FROM products
        ORDER BY created_at DESC
        LIMIT ?
        OFFSET ?
    `).all(limit, offset).map(parseProduct).map((product) => hydrateProduct(db, product));
}

function listProductCategories(db, options = {}) {
    const conditions = options.publishedOnly ? "WHERE published = 1" : "";

    return uniqueStrings(db.prepare(`
        SELECT category, categories_json
        FROM products
        ${conditions}
    `).all()
        .flatMap(parseStoredCategories))
        .sort((left, right) => left.localeCompare(right, "fr", { sensitivity: "base" }));
}

function listAdminCategories(db) {
    const categoryMap = new Map();

    db.prepare(`
        SELECT category, categories_json, published
        FROM products
        ORDER BY created_at DESC
    `).all()
        .forEach((product) => {
            for (const category of parseStoredCategories(product)) {
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

module.exports = {
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
};
