const {
    cloneOrderItems,
    consumeOrderItems,
    createInventoryMutator,
    isInventoryReserved,
    releaseOrderInventory,
    reserveOrderInventory,
    shouldReleaseInventoryForStatus,
} = require("./order-inventory-service");
const logger = require("./logger");

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
    const inventoryAlreadyReserved = isInventoryReserved(order.metadata);
    const nextMetadata = {
        ...(metadata ? { ...order.metadata, ...metadata } : order.metadata),
        payment_recorded_at: order.metadata?.payment_recorded_at || timestamp,
    };
    const transaction = db.transaction(() => {
        const nextItems = cloneOrderItems(order.items || []);

        if (!paymentAlreadyRecorded && !inventoryAlreadyReserved) {
            const mutator = createInventoryMutator({ db, getProductById, timestamp });

            consumeOrderItems(nextItems, mutator);
            mutator.flushConfigurationUpdates();
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
            `).run(timestamp, promoCodeId);

            if (!promoCodeUpdate.changes) {
                throw new Error("Le code promo lié à cette commande est introuvable.");
            }
        }
    });

    try {
        transaction();
        logger.info(`[inventory] Marked order ${order.order_number} paid${inventoryAlreadyReserved ? " from reserved stock" : ""}`);
    } catch (error) {
        logger.error(`[inventory] Paid finalization failed for order ${order.order_number}: ${error.message}`);
        throw error;
    }

    return getOrderById(db, orderId);
}

module.exports = {
    markOrderPaid,
    releaseOrderInventory,
    reserveOrderInventory,
    shouldReleaseInventoryForStatus,
};
