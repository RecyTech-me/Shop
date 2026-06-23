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
    if (category) {
        conditions.push("(LOWER(category) = ? OR LOWER(categories_json) LIKE ?)");
        values.push(category.toLowerCase(), `%"${category.toLowerCase().replace(/"/g, '\\"')}"%`);
    }

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
    `).all(...values).map(parseProduct).map((product) => hydrateProduct(db, product));

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
