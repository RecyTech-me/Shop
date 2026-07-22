const {
    formatCategoryList,
    parseCategoryList,
    parseCategoryListStrict,
    parseInfoRows,
    parseJsonArray,
    parseLineList,
    uniqueStrings,
} = require("./product-normalizer-utils");
const {
    parseOptionGroupsStrict,
    formatOptionGroups,
    parseValidConfigurationsStrict,
    formatValidConfigurations,
    normalizeConfigurationQuantity,
    getConfigurationSelections,
    findProductConfiguration,
    getConfigurationAvailableQuantity,
} = require("./product-configurations");
const {
    parseBundleItemsStrict: parseBundleItemsStrictBase,
    formatBundleItems,
} = require("./product-bundles");

const HYDRATE_PRODUCT_COLUMNS = `
    id, slug, product_kind, name, category, categories_json, short_description, description, admin_notes, image_url,
    image_gallery_json, option_groups_json, info_rows_json, valid_configurations_json, bundle_items_json,
    price_cents, starting_price_cents, maximum_price_cents, currency, inventory, featured, published,
    created_at, updated_at
`;

function normalizeProductKind(value) {
    return String(value || "").trim().toLowerCase() === "pack" ? "pack" : "product";
}

function formatInfoRows(rows) {
    return (rows || [])
        .map((row) => `${row.label}: ${row.value}`)
        .join("\n");
}

function parseBundleItemsStrict(db, value, currentProductId = null) {
    return parseBundleItemsStrictBase({
        db,
        value,
        currentProductId,
        parseProduct,
        normalizeProductKind,
        findProductConfiguration,
    });
}

function parseProduct(product) {
    if (!product) {
        return null;
    }

    const productKind = normalizeProductKind(product.product_kind);
    const categories = uniqueStrings([
        ...parseJsonArray(product.categories_json).flatMap((value) => parseCategoryList(value)),
        ...parseCategoryList(product.category),
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
            const rawQuantity = !Array.isArray(configuration) && configuration?.quantity !== undefined && configuration?.quantity !== null && configuration?.quantity !== ""
                ? Number(configuration.quantity)
                : null;
            const serviceTags = !Array.isArray(configuration) && Array.isArray(configuration?.service_tags)
                ? uniqueStrings(configuration.service_tags.map((tag) => String(tag || "").trim()))
                : [];

            return {
                selections: selectionsSource
                    .map((selection) => ({
                        name: String(selection?.name || "").trim(),
                        value: String(selection?.value || "").trim(),
                    }))
                    .filter((selection) => selection.name && selection.value),
                price_cents: Number.isInteger(priceCents) && priceCents >= 0 ? priceCents : null,
                quantity: normalizeConfigurationQuantity(
                    Number.isInteger(rawQuantity) && rawQuantity >= 0 ? rawQuantity : null,
                    serviceTags
                ),
                service_tags: serviceTags,
            };
        })
        .filter((configuration) => configuration.selections.length === option_groups.length)
        .filter((configuration) => configuration.selections.every((selection, index) =>
            selection.name === option_groups[index]?.name &&
            option_groups[index]?.values.includes(selection.value)
        ));
    const public_valid_configurations = valid_configurations.map((configuration) => ({
        selections: configuration.selections.map((selection) => ({ ...selection })),
        price_cents: configuration.price_cents,
        ...(Number.isInteger(configuration.quantity) ? { quantity: configuration.quantity } : {}),
    }));
    const has_configuration_pricing = valid_configurations.some((configuration) => configuration.price_cents !== null);
    const configurationPrices = valid_configurations.map((configuration) => configuration.price_cents ?? product.price_cents);
    const starting_price_cents = has_configuration_pricing && configurationPrices.length
        ? Math.min(...configurationPrices)
        : product.price_cents;
    const maximum_price_cents = has_configuration_pricing && configurationPrices.length
        ? Math.max(...configurationPrices)
        : product.price_cents;
    const bundle_items = parseJsonArray(product.bundle_items_json)
        .map((item) => ({
            product_id: Number.parseInt(item?.product_id, 10) || 0,
            slug: String(item?.slug || "").trim(),
            name: String(item?.name || "").trim(),
            quantity: Math.max(1, Number.parseInt(item?.quantity, 10) || 1),
            selected_options: Array.isArray(item?.selected_options)
                ? item.selected_options
                    .map((option) => ({
                        name: String(option?.name || "").trim(),
                        value: String(option?.value || "").trim(),
                    }))
                    .filter((option) => option.name && option.value)
                : [],
        }))
        .filter((item) => item.product_id > 0);

    return {
        ...product,
        product_kind: productKind,
        is_pack: productKind === "pack",
        category,
        categories,
        admin_notes: String(product.admin_notes || "").trim(),
        image_gallery_urls,
        gallery_images: uniqueStrings([String(product.image_url || "").trim(), ...image_gallery_urls]),
        option_groups,
        info_rows,
        valid_configurations,
        public_valid_configurations,
        bundle_items,
        has_configuration_pricing,
        starting_price_cents,
        maximum_price_cents,
        image_gallery_text: image_gallery_urls.join("\n"),
        categories_text: formatCategoryList(categories),
        option_groups_text: formatOptionGroups(option_groups),
        info_rows_text: formatInfoRows(info_rows),
        valid_configurations_text: formatValidConfigurations(valid_configurations),
        bundle_items_text: formatBundleItems(bundle_items),
    };
}

function hydrateProduct(db, product, cache = new Map(), stack = new Set()) {
    if (!product) {
        return null;
    }

    if (cache.has(product.id)) {
        return cache.get(product.id);
    }

    const hydrated = {
        ...product,
        categories: [...(product.categories || [])],
        image_gallery_urls: [...(product.image_gallery_urls || [])],
        gallery_images: [...(product.gallery_images || [])],
        option_groups: (product.option_groups || []).map((group) => ({
            ...group,
            values: [...(group.values || [])],
        })),
        info_rows: (product.info_rows || []).map((row) => ({ ...row })),
        valid_configurations: (product.valid_configurations || []).map((configuration) => ({
            ...configuration,
            selections: getConfigurationSelections(configuration).map((selection) => ({ ...selection })),
            service_tags: [...(configuration.service_tags || [])],
        })),
        public_valid_configurations: (product.public_valid_configurations || []).map((configuration) => ({
            ...configuration,
            selections: getConfigurationSelections(configuration).map((selection) => ({ ...selection })),
        })),
        bundle_items: (product.bundle_items || []).map((item) => ({
            ...item,
            selected_options: (item.selected_options || []).map((option) => ({ ...option })),
        })),
    };

    cache.set(hydrated.id, hydrated);

    if (!hydrated.is_pack) {
        return hydrated;
    }

    if (stack.has(hydrated.id)) {
        hydrated.bundle_items = [];
        hydrated.inventory = 0;
        hydrated.bundle_items_text = "";
        return hydrated;
    }

    stack.add(hydrated.id);

    const resolvedBundleItems = hydrated.bundle_items.map((item) => {
        let component = cache.get(item.product_id) || null;
        if (!component) {
            const record = db.prepare(`SELECT ${HYDRATE_PRODUCT_COLUMNS} FROM products WHERE id = ?`).get(item.product_id);
            component = record ? hydrateProduct(db, parseProduct(record), cache, stack) : null;
        }
        const availableQuantity = component && !component.is_pack
            ? getConfigurationAvailableQuantity(component, item.selected_options || [])
            : 0;

        return {
            ...item,
            slug: component?.slug || item.slug,
            name: component?.name || item.name,
            product: component,
            available_quantity: availableQuantity,
            total_available_quantity: Math.floor(availableQuantity / Math.max(item.quantity || 1, 1)),
        };
    }).filter((item) => item.product && !item.product.is_pack);

    hydrated.bundle_items = resolvedBundleItems;
    hydrated.bundle_items_text = formatBundleItems(resolvedBundleItems);
    hydrated.inventory = resolvedBundleItems.length
        ? Math.max(0, Math.min(...resolvedBundleItems.map((item) => item.total_available_quantity)))
        : 0;
    hydrated.gallery_images = hydrated.gallery_images.length
        ? hydrated.gallery_images
        : uniqueStrings(resolvedBundleItems.map((item) => String(item.product?.image_url || "").trim()).filter(Boolean));
    hydrated.image_url = hydrated.image_url || hydrated.gallery_images[0] || "";
    hydrated.starting_price_cents = hydrated.price_cents;
    hydrated.maximum_price_cents = hydrated.price_cents;

    stack.delete(hydrated.id);
    return hydrated;
}

module.exports = {
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
    findProductConfiguration,
    getConfigurationAvailableQuantity,
};
