const {
    uniqueStrings,
    getConfigurationSelections,
    getConfigurationAvailableQuantity,
} = require("./product-normalizers");

function defaultNowIso() {
    return new Date().toISOString();
}

function markOrderPaid(db, orderId, options = {}) {
    const {
        metadata = null,
        getOrderById,
        getProductById,
        nowIso = defaultNowIso,
    } = options;
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

module.exports = { markOrderPaid };
