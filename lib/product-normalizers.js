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

function parseLinesWithNumbers(value) {
    return String(value || "")
        .split(/\r?\n/)
        .map((line, index) => ({
            line: line.trim(),
            lineNumber: index + 1,
        }))
        .filter((entry) => entry.line);
}

function parseCategoryList(value) {
    return uniqueStrings(
        String(value || "")
            .split(/[\r\n,]+/)
            .map((item) => item.trim())
            .filter(Boolean)
    );
}

function parseCategoryListStrict(value) {
    const categories = [];

    for (const { line, lineNumber } of parseLinesWithNumbers(value)) {
        const parts = line.split(",");

        if (parts.some((part) => !part.trim())) {
            throw new Error(`Ligne ${lineNumber} des catégories : catégorie vide ou virgule mal placée.`);
        }

        categories.push(...parts.map((part) => part.trim()));
    }

    return uniqueStrings(categories);
}

function formatCategoryList(categories) {
    return (categories || []).join("\n");
}

function normalizeProductKind(value) {
    return String(value || "").trim().toLowerCase() === "pack" ? "pack" : "product";
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

function parseOptionGroupsStrict(value) {
    const groups = [];
    const seenNames = new Set();

    for (const { line, lineNumber } of parseLinesWithNumbers(value)) {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) {
            throw new Error(`Ligne ${lineNumber} des options : utilisez le format "Nom: valeur 1 | valeur 2".`);
        }

        const name = line.slice(0, separatorIndex).trim();
        const rawValues = line.slice(separatorIndex + 1).split("|");
        const values = rawValues.map((item) => item.trim()).filter(Boolean);

        if (!name) {
            throw new Error(`Ligne ${lineNumber} des options : le nom du groupe est vide.`);
        }

        if (!values.length || rawValues.some((item) => !item.trim())) {
            throw new Error(`Ligne ${lineNumber} des options : chaque groupe doit contenir des valeurs valides séparées par "|".`);
        }

        const normalizedName = name.toLocaleLowerCase("fr-CH");
        if (seenNames.has(normalizedName)) {
            throw new Error(`Ligne ${lineNumber} des options : le groupe "${name}" est défini plusieurs fois.`);
        }

        const uniqueValues = uniqueStrings(values);
        if (uniqueValues.length !== values.length) {
            throw new Error(`Ligne ${lineNumber} des options : le groupe "${name}" contient des valeurs en double.`);
        }

        seenNames.add(normalizedName);
        groups.push({ name, values: uniqueValues });
    }

    return groups;
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

function parseBundleItems(value) {
    return parseLineList(value)
        .map((line) => {
            const parts = line.split(";").map((part) => part.trim()).filter(Boolean);
            if (!parts.length) {
                return null;
            }

            const identifier = parts.shift();
            let quantity = 1;
            const selectedOptions = [];

            for (const part of parts) {
                const separatorIndex = part.indexOf("=");
                if (separatorIndex === -1) {
                    return null;
                }

                const name = part.slice(0, separatorIndex).trim();
                const optionValue = part.slice(separatorIndex + 1).trim();
                if (!name || !optionValue) {
                    return null;
                }

                if (name.toLowerCase() === "qty") {
                    quantity = Number.parseInt(optionValue, 10);
                    continue;
                }

                selectedOptions.push({ name, value: optionValue });
            }

            if (!identifier || !Number.isInteger(quantity) || quantity <= 0) {
                return null;
            }

            return {
                product_identifier: identifier,
                quantity,
                selected_options: selectedOptions,
            };
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

function splitConfigurationPriceStrict(line, lineNumber) {
    let configurationText = String(line || "").trim();
    let priceCents = null;
    const priceMarkerIndex = configurationText.lastIndexOf("=>");

    if (priceMarkerIndex !== -1) {
        const priceText = configurationText.slice(priceMarkerIndex + 2).trim();
        priceCents = parseMoneyToCents(priceText);
        configurationText = configurationText.slice(0, priceMarkerIndex).trim();

        if (priceCents === null) {
            throw new Error(`Ligne ${lineNumber} des combinaisons : prix invalide.`);
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
                throw new Error(`Ligne ${lineNumber} des combinaisons : prix invalide.`);
            }
        }
    }

    if (!configurationText) {
        throw new Error(`Ligne ${lineNumber} des combinaisons : combinaison vide.`);
    }

    return { configurationText, priceCents };
}

const CONFIGURATION_QUANTITY_KEYS = new Set(["stock", "stocks", "qty", "qte", "quantite", "quantity"]);
const CONFIGURATION_SERVICE_TAG_KEYS = new Set(["tag", "tags", "service_tag", "service_tags", "serial", "serials"]);

function normalizeConfigurationMetaName(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "_");
}

function parseConfigurationServiceTags(value) {
    return uniqueStrings(
        String(value || "")
            .split(/[|,]+/)
            .map((item) => item.trim())
            .filter(Boolean)
    );
}

function normalizeConfigurationQuantity(rawQuantity, serviceTags) {
    if (Number.isInteger(rawQuantity) && rawQuantity >= 0) {
        return rawQuantity;
    }

    return serviceTags.length ? serviceTags.length : null;
}

function getConfigurationSelections(configuration) {
    if (Array.isArray(configuration)) {
        return configuration;
    }

    if (Array.isArray(configuration?.selections)) {
        return configuration.selections;
    }

    return [];
}

function findProductConfiguration(product, selectedOptions = []) {
    const configurations = Array.isArray(product?.valid_configurations)
        ? product.valid_configurations
        : [];

    if (!configurations.length) {
        return null;
    }

    return configurations.find((configuration) => {
        const selections = getConfigurationSelections(configuration);
        return selections.length === selectedOptions.length && selections.every((selection, index) =>
            selection.name === selectedOptions[index]?.name &&
            selection.value === selectedOptions[index]?.value
        );
    }) || null;
}

function getConfigurationAvailableQuantity(product, selectedOptions = []) {
    const configurations = Array.isArray(product?.valid_configurations)
        ? product.valid_configurations
        : [];

    if (!configurations.length) {
        return Math.max(0, product?.inventory || 0);
    }

    const configuration = findProductConfiguration(product, selectedOptions);
    if (!configuration) {
        return 0;
    }

    const configurationQuantity = Number.isInteger(configuration.quantity) && configuration.quantity >= 0
        ? configuration.quantity
        : product.inventory;

    return Math.max(0, Math.min(product.inventory, configurationQuantity));
}

function parseValidConfigurations(value, optionGroups) {
    const groupMap = new Map(optionGroups.map((group) => [group.name, group]));

    return uniqueStrings(parseLineList(value))
        .map((line) => {
            const pricedConfiguration = splitConfigurationPrice(line);
            if (!pricedConfiguration) {
                return null;
            }

            let quantity = null;
            let serviceTags = [];
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

                    if (group) {
                        if (!value || !group.values.includes(value)) {
                            return null;
                        }

                        return { name, value };
                    }

                    const metaName = normalizeConfigurationMetaName(name);
                    if (CONFIGURATION_QUANTITY_KEYS.has(metaName)) {
                        const nextQuantity = Number.parseInt(value, 10);
                        if (!Number.isInteger(nextQuantity) || nextQuantity < 0) {
                            return null;
                        }

                        quantity = nextQuantity;
                        return false;
                    }

                    if (CONFIGURATION_SERVICE_TAG_KEYS.has(metaName)) {
                        serviceTags = parseConfigurationServiceTags(value);
                        return false;
                    }

                    return null;
                });

            if (selections.some((selection) => selection === null)) {
                return null;
            }

            const filteredSelections = selections.filter(Boolean);
            if (filteredSelections.length !== optionGroups.length) {
                return null;
            }

            const byName = new Map(filteredSelections.map((selection) => [selection.name, selection.value]));
            const orderedSelections = optionGroups.map((group) => {
                const selectedValue = byName.get(group.name);
                return selectedValue ? { name: group.name, value: selectedValue } : null;
            });

            if (orderedSelections.some((selection) => !selection)) {
                return null;
            }

            return {
                selections: orderedSelections,
                price_cents: pricedConfiguration.priceCents,
                quantity: normalizeConfigurationQuantity(quantity, serviceTags),
                service_tags: serviceTags,
            };
        })
        .filter(Boolean)
        .filter((configuration, index, configurations) =>
            configurations.findIndex((item) => JSON.stringify(item.selections) === JSON.stringify(configuration.selections)) === index
        );
}

function parseValidConfigurationsStrict(value, optionGroups) {
    const entries = parseLinesWithNumbers(value);
    if (!entries.length) {
        return [];
    }

    if (!optionGroups.length) {
        throw new Error("Définissez d'abord les options du produit avant de saisir des combinaisons autorisées.");
    }

    const groupMap = new Map(optionGroups.map((group) => [group.name, group]));
    const seenConfigurations = new Set();

    return entries.map(({ line, lineNumber }) => {
        const pricedConfiguration = splitConfigurationPriceStrict(line, lineNumber);
        const rawParts = pricedConfiguration.configurationText.split(";").map((part) => part.trim());

        if (rawParts.some((part) => !part)) {
            throw new Error(`Ligne ${lineNumber} des combinaisons : séparateur ";" mal placé.`);
        }

        let quantity = null;
        let serviceTags = [];
        const selections = [];
        const seenNames = new Set();

        for (const part of rawParts) {
            const separatorIndex = part.indexOf("=");
            if (separatorIndex === -1) {
                throw new Error(`Ligne ${lineNumber} des combinaisons : utilisez le format "Option=valeur".`);
            }

            const name = part.slice(0, separatorIndex).trim();
            const value = part.slice(separatorIndex + 1).trim();

            if (!name || !value) {
                throw new Error(`Ligne ${lineNumber} des combinaisons : nom ou valeur manquant.`);
            }

            const normalizedName = normalizeConfigurationMetaName(name);
            if (seenNames.has(normalizedName)) {
                throw new Error(`Ligne ${lineNumber} des combinaisons : "${name}" est défini plusieurs fois.`);
            }
            seenNames.add(normalizedName);

            const group = groupMap.get(name);
            if (group) {
                if (!group.values.includes(value)) {
                    throw new Error(`Ligne ${lineNumber} des combinaisons : la valeur "${value}" n'est pas autorisée pour "${name}".`);
                }

                selections.push({ name, value });
                continue;
            }

            if (CONFIGURATION_QUANTITY_KEYS.has(normalizedName)) {
                const nextQuantity = Number.parseInt(value, 10);
                if (!Number.isInteger(nextQuantity) || nextQuantity < 0) {
                    throw new Error(`Ligne ${lineNumber} des combinaisons : stock invalide.`);
                }

                quantity = nextQuantity;
                continue;
            }

            if (CONFIGURATION_SERVICE_TAG_KEYS.has(normalizedName)) {
                const nextTags = parseConfigurationServiceTags(value);
                if (!nextTags.length) {
                    throw new Error(`Ligne ${lineNumber} des combinaisons : aucun tag de service valide.`);
                }

                if (nextTags.length !== value.split(/[|,]+/).map((item) => item.trim()).filter(Boolean).length) {
                    throw new Error(`Ligne ${lineNumber} des combinaisons : tags de service en double.`);
                }

                serviceTags = nextTags;
                continue;
            }

            throw new Error(`Ligne ${lineNumber} des combinaisons : "${name}" n'est ni une option valide, ni un champ reconnu.`);
        }

        if (selections.length !== optionGroups.length) {
            throw new Error(`Ligne ${lineNumber} des combinaisons : la combinaison doit définir exactement ${optionGroups.length} option(s).`);
        }

        const byName = new Map(selections.map((selection) => [selection.name, selection.value]));
        const orderedSelections = optionGroups.map((group) => {
            const selectedValue = byName.get(group.name);
            if (!selectedValue) {
                throw new Error(`Ligne ${lineNumber} des combinaisons : l'option "${group.name}" est manquante.`);
            }

            return { name: group.name, value: selectedValue };
        });

        const configurationKey = JSON.stringify(orderedSelections);
        if (seenConfigurations.has(configurationKey)) {
            throw new Error(`Ligne ${lineNumber} des combinaisons : cette combinaison est définie plusieurs fois.`);
        }
        seenConfigurations.add(configurationKey);

        return {
            selections: orderedSelections,
            price_cents: pricedConfiguration.priceCents,
            quantity: normalizeConfigurationQuantity(quantity, serviceTags),
            service_tags: serviceTags,
        };
    });
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

function resolveBundleProductRecord(db, identifier) {
    const normalized = String(identifier || "").trim();
    if (!normalized) {
        return null;
    }

    if (/^#?\d+$/.test(normalized)) {
        const productId = Number.parseInt(normalized.replace(/^#/, ""), 10);
        return db.prepare("SELECT * FROM products WHERE id = ?").get(productId) || null;
    }

    return db.prepare("SELECT * FROM products WHERE slug = ?").get(normalized) || null;
}

function parseBundleItemsStrict(db, value, currentProductId = null) {
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
                quantity = Number.parseInt(optionValue, 10);
                if (!Number.isInteger(quantity) || quantity <= 0) {
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

function formatValidConfigurations(configurations) {
    return (configurations || [])
        .map((configuration) => {
            const selections = getConfigurationSelections(configuration)
                .map((selection) => ({
                    name: String(selection?.name || "").trim(),
                    value: String(selection?.value || "").trim(),
                }))
                .filter((selection) => selection.name && selection.value);
            const priceCents = Number.isInteger(configuration?.price_cents)
                ? configuration.price_cents
                : null;
            const quantity = Number.isInteger(configuration?.quantity) && configuration.quantity >= 0
                ? configuration.quantity
                : null;
            const serviceTags = Array.isArray(configuration?.service_tags)
                ? uniqueStrings(configuration.service_tags.map((tag) => String(tag || "").trim()))
                : [];
            const parts = selections.map((selection) => `${selection.name}=${selection.value}`);

            if (quantity !== null) {
                parts.push(`stock=${quantity}`);
            }

            if (serviceTags.length) {
                parts.push(`tags=${serviceTags.join(" | ")}`);
            }

            const configurationText = parts.join(" ; ");
            return priceCents === null
                ? configurationText
                : `${configurationText} => ${(priceCents / 100).toFixed(2)}`;
        })
        .filter(Boolean)
        .join("\n");
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
        const record = db.prepare("SELECT * FROM products WHERE id = ?").get(item.product_id);
        const component = record ? hydrateProduct(db, parseProduct(record), cache, stack) : null;
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
    getConfigurationAvailableQuantity,
};
