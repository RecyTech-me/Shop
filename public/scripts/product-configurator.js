export function initProductConfigurators() {
    document.querySelectorAll("[data-product-configurator]").forEach((form) => {
        const selects = [...form.querySelectorAll("select[data-option-group]")];
        const message = form.querySelector("[data-product-configurator-message]");
        const quantityInput = form.querySelector("input[name=\"quantity\"]");
        const submitButton = form.querySelector("button[type=\"submit\"]");
        const productDetail = form.closest(".product-detail");
        const priceTarget = productDetail?.querySelector("[data-product-price]") || document.querySelector("[data-product-price]");
        const basePriceCents = Number.parseInt(form.dataset.basePriceCents || priceTarget?.dataset.basePriceCents || "0", 10) || 0;
        const startingPriceCents = Number.parseInt(form.dataset.startingPriceCents || priceTarget?.dataset.startingPriceCents || `${basePriceCents}`, 10) || basePriceCents;
        const currency = form.dataset.currency || priceTarget?.dataset.currency || "CHF";
        const hasConfigurationPricing = priceTarget?.dataset.hasConfigurationPricing === "true";
        const defaultMaxQuantity = Number.parseInt(quantityInput?.getAttribute("max") || "1", 10) || 1;

        if (!selects.length) {
            return;
        }

        let validConfigurations = [];

        try {
            validConfigurations = JSON.parse(form.dataset.validConfigurations || "[]");
        } catch {
            validConfigurations = [];
        }

        validConfigurations = Array.isArray(validConfigurations)
            ? validConfigurations
                .map((configuration) => {
                    const selections = Array.isArray(configuration)
                        ? configuration
                        : Array.isArray(configuration?.selections)
                            ? configuration.selections
                            : [];
                    const rawPriceCents = !Array.isArray(configuration) ? configuration?.price_cents : null;
                    const rawQuantity = !Array.isArray(configuration) ? configuration?.quantity : null;
                    const priceCents = Number.parseInt(rawPriceCents, 10);
                    const quantity = Number.parseInt(rawQuantity, 10);

                    return {
                        selections: selections
                            .map((selection) => ({
                                name: String(selection?.name || "").trim(),
                                value: String(selection?.value || "").trim(),
                            }))
                            .filter((selection) => selection.name && selection.value),
                        priceCents: Number.isInteger(priceCents) && priceCents >= 0 ? priceCents : null,
                        quantity: Number.isInteger(quantity) && quantity >= 0 ? quantity : null,
                    };
                })
                .filter((configuration) => configuration.selections.length)
            : [];

        if (!validConfigurations.length) {
            return;
        }

        function formatProductPrice(cents) {
            return new Intl.NumberFormat("fr-CH", {
                style: "currency",
                currency,
                maximumFractionDigits: 2,
            }).format((cents || 0) / 100);
        }

        function currentSelections() {
            return new Map(
                selects
                    .map((select) => [select.dataset.optionGroup || "", select.value])
                    .filter(([name]) => name)
            );
        }

        function isConfigurationCompatible(configuration, targetGroupName, candidateValue, selections) {
            return configuration.selections.every((selection) => {
                if (selection.name === targetGroupName) {
                    return selection.value === candidateValue;
                }

                const selectedValue = selections.get(selection.name);
                return !selectedValue || selectedValue === selection.value;
            });
        }

        function getCompleteConfiguration(selections) {
            if (selects.some((select) => !select.value)) {
                return null;
            }

            return validConfigurations.find((configuration) =>
                configuration.selections.length === selects.length &&
                configuration.selections.every((selection) =>
                    selections.get(selection.name) === selection.value
                )
            ) || null;
        }

        function syncProductPrice(selections) {
            if (!priceTarget || !hasConfigurationPricing) {
                return;
            }

            const configuration = getCompleteConfiguration(selections);
            const priceCents = configuration ? (configuration.priceCents ?? basePriceCents) : startingPriceCents;
            priceTarget.textContent = configuration
                ? formatProductPrice(priceCents)
                : `À partir de ${formatProductPrice(priceCents)}`;
        }

        function syncQuantityControls(configuration, incompatibleSelection) {
            if (!quantityInput) {
                return;
            }

            const maxQuantity = incompatibleSelection
                ? 0
                : configuration && Number.isInteger(configuration.quantity)
                    ? Math.max(0, Math.min(defaultMaxQuantity, configuration.quantity))
                    : defaultMaxQuantity;

            quantityInput.max = String(Math.max(maxQuantity, 1));

            if (maxQuantity > 0) {
                quantityInput.disabled = false;
                quantityInput.value = String(Math.min(Math.max(1, Number.parseInt(quantityInput.value || "1", 10) || 1), maxQuantity));
            } else {
                quantityInput.value = "1";
            }

            if (submitButton) {
                submitButton.disabled = maxQuantity <= 0;
            }
        }

        function syncConfigurator() {
            const selections = currentSelections();

            selects.forEach((select) => {
                const groupName = select.dataset.optionGroup || "";
                const currentValue = select.value;

                [...select.options].forEach((option) => {
                    if (!option.value) {
                        option.disabled = false;
                        return;
                    }

                    option.disabled = !validConfigurations.some((configuration) =>
                        isConfigurationCompatible(configuration, groupName, option.value, selections)
                    );
                });

                if (currentValue && select.selectedOptions[0]?.disabled) {
                    select.value = "";
                }
            });

            const finalSelections = currentSelections();
            const completeConfiguration = getCompleteConfiguration(finalSelections);
            const hasPartialSelection = selects.some((select) => select.value);
            const hasAnyCompatibleConfiguration = validConfigurations.some((configuration) =>
                configuration.selections.every((selection) => {
                    const selectedValue = finalSelections.get(selection.name);
                    return !selectedValue || selectedValue === selection.value;
                })
            );
            const outOfStockConfiguration = completeConfiguration && Number.isInteger(completeConfiguration.quantity) && completeConfiguration.quantity <= 0;

            if (message) {
                if (outOfStockConfiguration) {
                    message.hidden = false;
                    message.textContent = "Cette combinaison n'est plus en stock.";
                } else if (hasPartialSelection && !hasAnyCompatibleConfiguration) {
                    message.hidden = false;
                    message.textContent = "Cette combinaison n'est pas disponible.";
                } else {
                    message.hidden = true;
                    message.textContent = "";
                }
            }

            syncProductPrice(finalSelections);
            syncQuantityControls(completeConfiguration, hasPartialSelection && !hasAnyCompatibleConfiguration);
        }

        selects.forEach((select) => {
            select.addEventListener("change", syncConfigurator);
        });

        syncConfigurator();
    });
}
