function createProductOptionReader({ normalizeText, getProductUnitPriceCents }) {
    function readSelectedProductOptions(product, body, fieldNameForIndex = (index) => `selected_option_${index}`) {
        const groups = Array.isArray(product.option_groups) ? product.option_groups : [];

        const selectedOptions = groups.map((group, index) => {
            const value = normalizeText(body[fieldNameForIndex(index, group)]);
            if (!group.values.includes(value)) {
                throw new Error(`Veuillez choisir une option valide pour « ${group.name} ».`);
            }

            return {
                name: group.name,
                value,
            };
        });

        getProductUnitPriceCents(product, selectedOptions);

        return selectedOptions;
    }

    return { readSelectedProductOptions };
}

module.exports = { createProductOptionReader };
