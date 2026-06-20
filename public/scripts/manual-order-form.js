export function initManualOrderForms() {
    document.querySelectorAll("[data-manual-order-form]").forEach((form) => {
        const productSelect = form.querySelector("[data-manual-order-product-select]");
        const unitPriceInput = form.querySelector("[data-manual-order-unit-price]");
        const quantityInput = form.querySelector("[data-manual-order-quantity]");
        const panels = [...form.querySelectorAll("[data-manual-order-option-panel]")];

        if (!productSelect) {
            return;
        }

        function formatManualOrderPrice(cents, currency) {
            return new Intl.NumberFormat("fr-CH", {
                style: "currency",
                currency: currency || "CHF",
                maximumFractionDigits: 2,
            }).format((cents || 0) / 100);
        }

        function parsePanelConfigurations(panel) {
            if (panel.manualOrderConfigurations) {
                return panel.manualOrderConfigurations;
            }

            let configurations = [];

            try {
                configurations = JSON.parse(panel.dataset.validConfigurations || "[]");
            } catch {
                configurations = [];
            }

            panel.manualOrderConfigurations = Array.isArray(configurations)
                ? configurations
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
                            serviceTags: !Array.isArray(configuration) && Array.isArray(configuration?.service_tags)
                                ? configuration.service_tags.map((tag) => String(tag || "").trim()).filter(Boolean)
                                : [],
                        };
                    })
                    .filter((configuration) => configuration.selections.length)
                : [];

            return panel.manualOrderConfigurations;
        }

        function getSelections(selects) {
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

        function getCompleteConfiguration(selects, configurations, selections) {
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

        function syncUnitPricePlaceholder(cents, currency) {
            if (!unitPriceInput) {
                return;
            }

            unitPriceInput.placeholder = `Laisser vide = ${formatManualOrderPrice(cents, currency)}`;
        }

        function syncPanel(panel) {
            const selects = [...panel.querySelectorAll("[data-manual-order-option-select]")];
            const message = panel.querySelector("[data-manual-order-option-message]");
            const stockHint = panel.querySelector("[data-manual-order-stock-hint]");
            const serviceTagsWrap = panel.querySelector("[data-manual-order-service-tags-wrap]");
            const serviceTagsSelect = panel.querySelector("[data-manual-order-service-tags]");
            const serviceTagsHint = panel.querySelector("[data-manual-order-service-tags-hint]");
            const priceHint = panel.querySelector("[data-manual-order-price-hint]");
            const configurations = parsePanelConfigurations(panel);
            const basePriceCents = Number.parseInt(panel.dataset.basePriceCents || "0", 10) || 0;
            const startingPriceCents = Number.parseInt(panel.dataset.startingPriceCents || `${basePriceCents}`, 10) || basePriceCents;
            const currency = panel.dataset.currency || "CHF";

            if (!configurations.length) {
                if (message) {
                    message.hidden = true;
                    message.textContent = "";
                }
                if (stockHint) {
                    stockHint.textContent = "";
                }
                if (serviceTagsWrap) {
                    serviceTagsWrap.hidden = true;
                }
                if (serviceTagsSelect) {
                    serviceTagsSelect.disabled = true;
                    serviceTagsSelect.name = "";
                    serviceTagsSelect.innerHTML = "";
                }
                if (serviceTagsHint) {
                    serviceTagsHint.textContent = "";
                }
                if (priceHint) {
                    priceHint.textContent = `Prix utilisé sans prix personnalisé : ${formatManualOrderPrice(basePriceCents, currency)}`;
                }
                if (quantityInput) {
                    quantityInput.removeAttribute("max");
                }
                syncUnitPricePlaceholder(basePriceCents, currency);
                return;
            }

            const selections = getSelections(selects);

            selects.forEach((select) => {
                const groupName = select.dataset.optionGroup || "";
                const currentValue = select.value;

                [...select.options].forEach((option) => {
                    if (!option.value) {
                        option.disabled = false;
                        return;
                    }

                    option.disabled = !configurations.some((configuration) =>
                        isConfigurationCompatible(configuration, groupName, option.value, selections)
                    );
                });

                if (currentValue && select.selectedOptions[0]?.disabled) {
                    select.value = "";
                }
            });

            const finalSelections = getSelections(selects);
            const completeConfiguration = getCompleteConfiguration(selects, configurations, finalSelections);
            const hasPartialSelection = selects.some((select) => select.value);
            const hasAnyCompatibleConfiguration = configurations.some((configuration) =>
                configuration.selections.every((selection) => {
                    const selectedValue = finalSelections.get(selection.name);
                    return !selectedValue || selectedValue === selection.value;
                })
            );
            const priceCents = completeConfiguration
                ? (completeConfiguration.priceCents ?? basePriceCents)
                : startingPriceCents;

            if (message) {
                const outOfStockConfiguration = completeConfiguration && Number.isInteger(completeConfiguration.quantity) && completeConfiguration.quantity <= 0;
                if (outOfStockConfiguration) {
                    message.hidden = false;
                    message.textContent = "Cette combinaison n'est plus disponible.";
                } else if (hasPartialSelection && !hasAnyCompatibleConfiguration) {
                    message.hidden = false;
                    message.textContent = "Cette combinaison n'est pas disponible.";
                } else {
                    message.hidden = true;
                    message.textContent = "";
                }
            }

            if (stockHint) {
                if (completeConfiguration && Number.isInteger(completeConfiguration.quantity)) {
                    const tagText = completeConfiguration.serviceTags.length
                        ? ` Tags de service disponibles : ${completeConfiguration.serviceTags.join(", ")}`
                        : "";
                    stockHint.textContent = `Disponible pour cette combinaison : ${completeConfiguration.quantity} unité(s).${tagText}`;
                } else {
                    stockHint.textContent = "";
                }
            }

            if (serviceTagsWrap && serviceTagsSelect && serviceTagsHint) {
                const availableServiceTags = completeConfiguration?.serviceTags || [];
                const requestedQuantity = Math.max(1, Number.parseInt(quantityInput?.value || "1", 10) || 1);
                const requiredTagCount = Math.min(requestedQuantity, availableServiceTags.length);
                const previousSelection = [...serviceTagsSelect.selectedOptions]
                    .map((option) => option.value)
                    .filter((value) => availableServiceTags.includes(value));
                const nextSelection = previousSelection.slice(0, requiredTagCount);

                for (const tag of availableServiceTags) {
                    if (nextSelection.length >= requiredTagCount) {
                        break;
                    }
                    if (!nextSelection.includes(tag)) {
                        nextSelection.push(tag);
                    }
                }

                serviceTagsSelect.innerHTML = availableServiceTags
                    .map((tag) => `<option value="${tag.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"${nextSelection.includes(tag) ? " selected" : ""}>${tag.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</option>`)
                    .join("");
                serviceTagsSelect.disabled = !availableServiceTags.length;
                serviceTagsSelect.name = availableServiceTags.length ? "service_tags" : "";
                serviceTagsSelect.size = Math.min(Math.max(availableServiceTags.length, 2), 6);
                serviceTagsWrap.hidden = !availableServiceTags.length;
                if (availableServiceTags.length) {
                    serviceTagsHint.textContent = requiredTagCount > 0
                        ? (requiredTagCount === 1
                            ? "Choisissez le tag de service de l'unité vendue."
                            : `Choisissez exactement ${requiredTagCount} tags de service pour cette vente.`)
                        : "Aucun tag de service requis pour cette quantité.";
                } else {
                    serviceTagsHint.textContent = "";
                }
            }

            if (quantityInput) {
                const maxQuantity = completeConfiguration && Number.isInteger(completeConfiguration.quantity)
                    ? Math.max(1, completeConfiguration.quantity)
                    : 1;
                quantityInput.max = String(maxQuantity);
                quantityInput.value = String(Math.min(Math.max(1, Number.parseInt(quantityInput.value || "1", 10) || 1), maxQuantity));
            }

            if (priceHint) {
                priceHint.textContent = completeConfiguration
                    ? `Prix utilisé sans prix personnalisé : ${formatManualOrderPrice(priceCents, currency)}`
                    : `Prix utilisé sans prix personnalisé : à partir de ${formatManualOrderPrice(priceCents, currency)}`;
            }

            syncUnitPricePlaceholder(priceCents, currency);
        }

        function syncProductOptions() {
            const selectedProductId = productSelect.value;
            const selectedProductOption = productSelect.selectedOptions[0];
            let activePanel = null;

            panels.forEach((panel) => {
                const isActive = panel.dataset.productId === selectedProductId;
                const selects = [...panel.querySelectorAll("[data-manual-order-option-select]")];

                panel.hidden = !isActive;

                const serviceTagsSelect = panel.querySelector("[data-manual-order-service-tags]");
                const serviceTagsWrap = panel.querySelector("[data-manual-order-service-tags-wrap]");

                selects.forEach((select, index) => {
                    select.disabled = !isActive;
                    select.required = isActive;
                    select.name = isActive ? `selected_option_${select.dataset.optionIndex || index}` : "";
                });

                if (serviceTagsSelect) {
                    serviceTagsSelect.disabled = !isActive;
                    serviceTagsSelect.name = isActive ? serviceTagsSelect.name : "";
                }
                if (!isActive && serviceTagsWrap) {
                    serviceTagsWrap.hidden = true;
                }

                if (isActive) {
                    activePanel = panel;
                }
            });

            if (activePanel) {
                syncPanel(activePanel);
                return;
            }

            const basePriceCents = Number.parseInt(selectedProductOption?.dataset.basePriceCents || "0", 10) || 0;
            const currency = selectedProductOption?.dataset.currency || "CHF";
            if (quantityInput) {
                quantityInput.removeAttribute("max");
            }
            syncUnitPricePlaceholder(basePriceCents, currency);
        }

        panels.forEach((panel) => {
            panel.querySelectorAll("[data-manual-order-option-select]").forEach((select) => {
                select.addEventListener("change", () => syncPanel(panel));
            });
        });

        panels.forEach((panel) => {
            panel.querySelectorAll("[data-manual-order-service-tags]").forEach((select) => {
                select.addEventListener("change", () => syncPanel(panel));
            });
        });

        quantityInput?.addEventListener("input", () => {
            const activePanel = panels.find((panel) => !panel.hidden);
            if (activePanel) {
                syncPanel(activePanel);
            }
        });

        productSelect.addEventListener("change", syncProductOptions);
        syncProductOptions();
    });
}
