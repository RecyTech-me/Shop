const {
    parseLinesWithNumbers,
    uniqueStrings,
} = require("./product-normalizer-utils");

const CONFIGURATION_QUANTITY_KEYS = new Set(["stock", "stocks", "qty", "qte", "quantite", "quantity"]);
const CONFIGURATION_SERVICE_TAG_KEYS = new Set(["tag", "tags", "service_tag", "service_tags", "serial", "serials"]);

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

module.exports = {
    parseOptionGroupsStrict,
    formatOptionGroups,
    parseValidConfigurationsStrict,
    formatValidConfigurations,
    normalizeConfigurationQuantity,
    getConfigurationSelections,
    findProductConfiguration,
    getConfigurationAvailableQuantity,
};
