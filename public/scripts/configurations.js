export function parseConfigurations(value, options = {}) {
    const { includeServiceTags = false } = options;
    let configurations = [];

    try {
        configurations = JSON.parse(value || "[]");
    } catch {
        configurations = [];
    }

    return Array.isArray(configurations)
        ? configurations
            .map((configuration) => {
                const selections = getConfigurationSelections(configuration);
                const rawPriceCents = !Array.isArray(configuration) ? configuration?.price_cents : null;
                const rawQuantity = !Array.isArray(configuration) ? configuration?.quantity : null;
                const priceCents = Number.parseInt(rawPriceCents, 10);
                const quantity = Number.parseInt(rawQuantity, 10);

                return {
                    selections,
                    priceCents: Number.isInteger(priceCents) && priceCents >= 0 ? priceCents : null,
                    quantity: Number.isInteger(quantity) && quantity >= 0 ? quantity : null,
                    serviceTags: includeServiceTags && !Array.isArray(configuration) && Array.isArray(configuration?.service_tags)
                        ? configuration.service_tags.map((tag) => String(tag || "").trim()).filter(Boolean)
                        : [],
                };
            })
            .filter((configuration) => configuration.selections.length)
        : [];
}

export function getConfigurationSelections(configuration) {
    const selections = Array.isArray(configuration)
        ? configuration
        : Array.isArray(configuration?.selections)
            ? configuration.selections
            : [];

    return selections
        .map((selection) => ({
            name: String(selection?.name || "").trim(),
            value: String(selection?.value || "").trim(),
        }))
        .filter((selection) => selection.name && selection.value);
}

export function getCurrentSelections(selects) {
    return new Map(
        selects
            .map((select) => [select.dataset.optionGroup || "", select.value])
            .filter(([name]) => name)
    );
}

export function isConfigurationCompatible(configuration, targetGroupName, candidateValue, selections) {
    return configuration.selections.every((selection) => {
        if (selection.name === targetGroupName) {
            return selection.value === candidateValue;
        }

        const selectedValue = selections.get(selection.name);
        return !selectedValue || selectedValue === selection.value;
    });
}

export function hasCompatibleConfiguration(configurations, selections) {
    return configurations.some((configuration) =>
        configuration.selections.every((selection) => {
            const selectedValue = selections.get(selection.name);
            return !selectedValue || selectedValue === selection.value;
        })
    );
}

export function findCompleteConfiguration(selects, configurations, selections) {
    if (selects.some((select) => !select.value)) {
        return null;
    }

    return configurations.find((configuration) =>
        configuration.selections.length === selects.length &&
        configuration.selections.every((selection) =>
            selections.get(selection.name) === selection.value
        )
    ) || null;
}
