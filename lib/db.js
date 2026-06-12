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
