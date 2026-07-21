const { parseLinesWithNumbers } = require("./product-normalizer-utils");

const BUNDLE_PRODUCT_COLUMNS = `
    id, slug, product_kind, name, category, categories_json, short_description, description, admin_notes, image_url,
    image_gallery_json, option_groups_json, info_rows_json, valid_configurations_json, bundle_items_json,
    price_cents, starting_price_cents, maximum_price_cents, currency, inventory, featured, published,
    created_at, updated_at
`;

function resolveBundleProductRecord(db, identifier) {
    const normalized = String(identifier || "").trim();
    if (!normalized) {
        return null;
    }

    if (/^#?\d+$/.test(normalized)) {
        const productId = Number.parseInt(normalized.replace(/^#/, ""), 10);
        return db.prepare(`SELECT ${BUNDLE_PRODUCT_COLUMNS} FROM products WHERE id = ?`).get(productId) || null;
    }

    return db.prepare(`SELECT ${BUNDLE_PRODUCT_COLUMNS} FROM products WHERE slug = ?`).get(normalized) || null;
}

function parseBundleItemsStrict({
    db,
    value,
    currentProductId = null,
    parseProduct,
    normalizeProductKind,
    findProductConfiguration,
}) {
    const bundleItems = [];
    const seenKeys = new Set();

    for (const { line, lineNumber } of parseLinesWithNumbers(value)) {
        const parts = line.split(";").map((part) => part.trim()).filter(Boolean);
        if (!parts.length) {
            continue;
        }

        const identifier = parts.shift();
        const record = resolveBundleProductRecord(db, identifier);
        if (!record) {
            throw new Error(`Ligne ${lineNumber} du pack : produit introuvable (${identifier}).`);
        }

        if (currentProductId && Number(record.id) === Number(currentProductId)) {
            throw new Error(`Ligne ${lineNumber} du pack : un pack ne peut pas se contenir lui-même.`);
        }

        const product = parseProduct(record);
        if (normalizeProductKind(product.product_kind) === "pack") {
            throw new Error(`Ligne ${lineNumber} du pack : les packs imbriqués ne sont pas autorisés (${product.name}).`);
        }

        let quantity = 1;
        const selectedOptions = [];
        const seenOptionNames = new Set();

        for (const part of parts) {
            const separatorIndex = part.indexOf("=");
            if (separatorIndex === -1) {
                throw new Error(`Ligne ${lineNumber} du pack : utilisez le format \"slug ; qty=2 ; Option=Valeur\".`);
            }

            const name = part.slice(0, separatorIndex).trim();
            const optionValue = part.slice(separatorIndex + 1).trim();
            if (!name || !optionValue) {
                throw new Error(`Ligne ${lineNumber} du pack : élément incomplet.`);
            }

            if (name.toLowerCase() === "qty") {
                quantity = /^\d+$/.test(optionValue) ? Number(optionValue) : Number.NaN;
                if (!Number.isSafeInteger(quantity) || quantity <= 0) {
                    throw new Error(`Ligne ${lineNumber} du pack : quantité invalide.`);
                }
                continue;
            }

            const optionKey = name.toLocaleLowerCase("fr-CH");
            if (seenOptionNames.has(optionKey)) {
                throw new Error(`Ligne ${lineNumber} du pack : l'option \"${name}\" est définie plusieurs fois.`);
            }
            seenOptionNames.add(optionKey);
            selectedOptions.push({ name, value: optionValue });
        }

        if ((product.option_groups || []).length) {
            if (selectedOptions.length !== product.option_groups.length) {
                throw new Error(`Ligne ${lineNumber} du pack : toutes les options de \"${product.name}\" doivent être précisées.`);
            }

            for (const group of product.option_groups) {
                const selected = selectedOptions.find((option) => option.name === group.name);
                if (!selected) {
                    throw new Error(`Ligne ${lineNumber} du pack : l'option \"${group.name}\" manque pour \"${product.name}\".`);
                }

                if (!group.values.includes(selected.value)) {
                    throw new Error(`Ligne ${lineNumber} du pack : la valeur \"${selected.value}\" n'est pas autorisée pour \"${group.name}\".`);
                }
            }

            if (product.valid_configurations?.length && !findProductConfiguration(product, selectedOptions)) {
                throw new Error(`Ligne ${lineNumber} du pack : la combinaison choisie n'est pas disponible pour \"${product.name}\".`);
            }
        } else if (selectedOptions.length) {
            throw new Error(`Ligne ${lineNumber} du pack : \"${product.name}\" n'a pas d'options à préciser.`);
        }

        const itemKey = `${product.id}:${JSON.stringify(selectedOptions)}`;
        if (seenKeys.has(itemKey)) {
            throw new Error(`Ligne ${lineNumber} du pack : ce produit est déjà présent avec les mêmes options.`);
        }
        seenKeys.add(itemKey);

        bundleItems.push({
            product_id: product.id,
            slug: product.slug,
            name: product.name,
            quantity,
            selected_options: selectedOptions,
        });
    }

    return bundleItems;
}

function formatBundleItems(bundleItems) {
    return (bundleItems || []).map((item) => {
        const parts = [item.slug || `#${item.product_id}`];
        if ((item.quantity || 1) !== 1) {
            parts.push(`qty=${item.quantity}`);
        }

        for (const option of item.selected_options || []) {
            parts.push(`${option.name}=${option.value}`);
        }

        return parts.join(" ; ");
    }).join("\n");
}

module.exports = {
    parseBundleItemsStrict,
    formatBundleItems,
};
