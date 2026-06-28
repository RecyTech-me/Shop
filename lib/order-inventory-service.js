const {
    uniqueStrings,
    getConfigurationSelections,
    getConfigurationAvailableQuantity,
} = require("./product-normalizers");
const logger = require("./logger");

const INVENTORY_RELEASE_STATUSES = new Set(["failed", "cancelled", "refunded"]);

function defaultNowIso() {
    return new Date().toISOString();
}

function cloneOrderItems(items = []) {
    return items.map((item) => ({
        ...item,
        service_tags: Array.isArray(item.service_tags)
            ? uniqueStrings(item.service_tags.map((tag) => String(tag || "").trim()))
            : [],
        bundle_items: Array.isArray(item.bundle_items)
            ? item.bundle_items.map((bundleItem) => ({
                ...bundleItem,
                selected_options: Array.isArray(bundleItem.selected_options)
                    ? bundleItem.selected_options.map((option) => ({ ...option }))
                    : [],
                service_tags: Array.isArray(bundleItem.service_tags)
                    ? uniqueStrings(bundleItem.service_tags.map((tag) => String(tag || "").trim()))
                    : [],
            }))
            : item.bundle_items,
    }));
}

function isInventoryReserved(metadata = {}) {
    return Boolean(metadata.inventory_reserved_at && !metadata.inventory_released_at);
}

function canReleaseInventoryReservation(metadata = {}) {
    return isInventoryReserved(metadata) && !metadata.payment_recorded_at;
}

function shouldReleaseInventoryForStatus(status) {
    return INVENTORY_RELEASE_STATUSES.has(status);
}

function createInventoryMutator({ db, getProductById, timestamp }) {
    const updateInventory = db.prepare(`
        UPDATE products
        SET inventory = inventory - ?,
            updated_at = ?
        WHERE id = ?
          AND inventory >= ?
    `);
    const restoreInventory = db.prepare(`
        UPDATE products
        SET inventory = inventory + ?,
            updated_at = ?
        WHERE id = ?
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

    function findConfiguration(product, selectedOptions) {
        return (product.valid_configurations || []).find((candidate) => {
            const selections = getConfigurationSelections(candidate);
            return selections.length === selectedOptions.length && selections.every((selection, index) =>
                selection.name === selectedOptions[index]?.name && selection.value === selectedOptions[index]?.value
            );
        });
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

        const configuration = findConfiguration(product, selectedOptions);
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

    function restoreProductQuantity(productId, quantity, selectedOptions = [], serviceTags = []) {
        const product = getMutableProduct(productId);
        if (!product) {
            return;
        }

        restoreInventory.run(quantity, timestamp, productId);

        const configuration = findConfiguration(product, selectedOptions);
        if (!configuration) {
            return;
        }

        if (Number.isInteger(configuration.quantity)) {
            configuration.quantity += quantity;
        }

        const normalizedServiceTags = Array.isArray(serviceTags)
            ? uniqueStrings(serviceTags.map((tag) => String(tag || "").trim()))
            : [];

        if (normalizedServiceTags.length) {
            configuration.service_tags = uniqueStrings([
                ...(Array.isArray(configuration.service_tags) ? configuration.service_tags : []),
                ...normalizedServiceTags,
            ]);
        }

        if (!Number.isInteger(configuration.quantity) && Array.isArray(configuration.service_tags)) {
            configuration.quantity = configuration.service_tags.length;
        }
    }

    function flushConfigurationUpdates() {
        for (const product of productsToUpdate.values()) {
            updateConfigurations.run(JSON.stringify(product.valid_configurations || []), timestamp, product.id);
        }
    }

    return {
        consumeProductQuantity,
        restoreProductQuantity,
        flushConfigurationUpdates,
    };
}

function consumeOrderItems(items, mutator) {
    for (const item of items) {
        if (item.is_pack && Array.isArray(item.bundle_items) && item.bundle_items.length) {
            item.bundle_items = item.bundle_items.map((bundleItem) => {
                const selectedOptions = Array.isArray(bundleItem.selected_options) ? bundleItem.selected_options : [];
                const componentQuantity = Math.max(1, Number.parseInt(bundleItem.quantity, 10) || 1) * item.quantity;
                const result = mutator.consumeProductQuantity(
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
        const result = mutator.consumeProductQuantity(
            item.product_id,
            item.name,
            item.quantity,
            selectedOptions,
            item.service_tags
        );
        item.service_tags = result.serviceTags;
    }
}

function restoreOrderItems(items, mutator) {
    for (const item of items) {
        if (item.is_pack && Array.isArray(item.bundle_items) && item.bundle_items.length) {
            for (const bundleItem of item.bundle_items) {
                const selectedOptions = Array.isArray(bundleItem.selected_options) ? bundleItem.selected_options : [];
                const componentQuantity = Math.max(1, Number.parseInt(bundleItem.quantity, 10) || 1) * item.quantity;
                mutator.restoreProductQuantity(
                    bundleItem.product_id,
                    componentQuantity,
                    selectedOptions,
                    bundleItem.service_tags
                );
            }
            continue;
        }

        const selectedOptions = Array.isArray(item.selected_options) ? item.selected_options : [];
        mutator.restoreProductQuantity(
            item.product_id,
            item.quantity,
            selectedOptions,
            item.service_tags
        );
    }
}

function reserveOrderInventory(db, orderId, options = {}) {
    const {
        metadata = null,
        getOrderById,
        getProductById,
        nowIso = defaultNowIso,
    } = options;
    const order = getOrderById(db, orderId);
    if (!order || order.metadata?.payment_recorded_at || isInventoryReserved(order.metadata)) {
        return order;
    }

    const timestamp = nowIso();
    const nextMetadata = {
        ...(metadata ? { ...order.metadata, ...metadata } : order.metadata),
        inventory_reserved_at: order.metadata?.inventory_reserved_at || timestamp,
    };

    const transaction = db.transaction(() => {
        const nextItems = cloneOrderItems(order.items || []);
        const mutator = createInventoryMutator({ db, getProductById, timestamp });

        consumeOrderItems(nextItems, mutator);
        mutator.flushConfigurationUpdates();

        db.prepare(`
            UPDATE orders
            SET metadata_json = ?,
                items_json = ?,
                updated_at = ?
            WHERE id = ?
        `).run(JSON.stringify(nextMetadata), JSON.stringify(nextItems), timestamp, orderId);
    });

    try {
        transaction();
        logger.info(`[inventory] Reserved stock for order ${order.order_number}`);
    } catch (error) {
        logger.error(`[inventory] Reservation failed for order ${order.order_number}: ${error.message}`);
        throw error;
    }

    return getOrderById(db, orderId);
}

function releaseOrderInventory(db, orderId, options = {}) {
    const {
        metadata = null,
        status = null,
        createdAt = null,
        getOrderById,
        getProductById,
        nowIso = defaultNowIso,
    } = options;
    const order = getOrderById(db, orderId);
    if (!order) {
        return null;
    }

    const timestamp = nowIso();
    const nextStatus = status || order.status;
    const nextCreatedAt = createdAt || order.created_at;

    if (!canReleaseInventoryReservation(order.metadata)) {
        const nextMetadata = metadata ? { ...order.metadata, ...metadata } : order.metadata;

        db.prepare(`
            UPDATE orders
            SET status = ?,
                metadata_json = ?,
                created_at = ?,
                updated_at = ?
            WHERE id = ?
        `).run(nextStatus, JSON.stringify(nextMetadata), nextCreatedAt, timestamp, orderId);

        return getOrderById(db, orderId);
    }

    const nextMetadata = {
        ...(metadata ? { ...order.metadata, ...metadata } : order.metadata),
        inventory_released_at: order.metadata?.inventory_released_at || timestamp,
    };

    const transaction = db.transaction(() => {
        const nextItems = cloneOrderItems(order.items || []);
        const mutator = createInventoryMutator({ db, getProductById, timestamp });

        restoreOrderItems(nextItems, mutator);
        mutator.flushConfigurationUpdates();

        db.prepare(`
            UPDATE orders
            SET status = ?,
                metadata_json = ?,
                items_json = ?,
                created_at = ?,
                updated_at = ?
            WHERE id = ?
        `).run(nextStatus, JSON.stringify(nextMetadata), JSON.stringify(nextItems), nextCreatedAt, timestamp, orderId);
    });

    try {
        transaction();
        logger.info(`[inventory] Released reserved stock for order ${order.order_number}`);
    } catch (error) {
        logger.error(`[inventory] Reservation release failed for order ${order.order_number}: ${error.message}`);
        throw error;
    }

    return getOrderById(db, orderId);
}

module.exports = {
    cloneOrderItems,
    consumeOrderItems,
    createInventoryMutator,
    isInventoryReserved,
    releaseOrderInventory,
    reserveOrderInventory,
    shouldReleaseInventoryForStatus,
};
