import {
    findCompleteConfiguration,
    getCurrentSelections,
    hasCompatibleConfiguration,
    isConfigurationCompatible,
    parseConfigurations,
} from "./configurations.js";

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

        const validConfigurations = parseConfigurations(form.dataset.validConfigurations);

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

        function syncProductPrice(selections) {
            if (!priceTarget || !hasConfigurationPricing) {
                return;
            }

            const configuration = findCompleteConfiguration(selects, validConfigurations, selections);
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
            const selections = getCurrentSelections(selects);

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

            const finalSelections = getCurrentSelections(selects);
            const completeConfiguration = findCompleteConfiguration(selects, validConfigurations, finalSelections);
            const hasPartialSelection = selects.some((select) => select.value);
            const hasAnyCompatibleConfiguration = hasCompatibleConfiguration(validConfigurations, finalSelections);
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
