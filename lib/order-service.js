const {
    cloneOrderItems,
    consumeOrderItems,
    createInventoryMutator,
    isInventoryReserved,
    releaseOrderInventory,
    reserveOrderInventory,
    shouldReleaseInventoryForStatus,
} = require("./order-inventory-service");
const { isPaidOrderStatus } = require("./order-statuses");
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
    let missingPromoCode = false;
    let orderNumber = "";
    let inventoryAlreadyReserved = false;
    const transaction = db.transaction(() => {
        const order = getOrderById(db, orderId);
        if (!order) {
            return;
        }

        orderNumber = order.order_number;
        const promoCodeId = Number.parseInt(order.metadata?.promo?.id, 10);
        const timestamp = nowIso();
        const paymentAlreadyRecorded = Boolean(order.metadata?.payment_recorded_at);
        const orderAlreadyInPaidState = isPaidOrderStatus(order.status);
        const shouldRecordFinancialEffects = !paymentAlreadyRecorded && !orderAlreadyInPaidState;
        const hasPromoReservation = Boolean(
            order.metadata?.promo_redemption_reserved_at
            && !order.metadata?.promo_redemption_released_at
            && !order.metadata?.promo_redemption_redeemed_at
        );
        inventoryAlreadyReserved = isInventoryReserved(order.metadata);
        const nextMetadata = {
            ...(metadata ? { ...order.metadata, ...metadata } : order.metadata),
            payment_recorded_at: order.metadata?.payment_recorded_at || timestamp,
            ...(hasPromoReservation ? { promo_redemption_redeemed_at: timestamp } : {}),
        };
        const nextItems = cloneOrderItems(order.items || []);

        if (shouldRecordFinancialEffects && !inventoryAlreadyReserved) {
            const mutator = createInventoryMutator({ db, getProductById, timestamp });

            consumeOrderItems(nextItems, mutator);
            mutator.flushConfigurationUpdates();
        }

        if (!paymentAlreadyRecorded && Number.isInteger(promoCodeId) && promoCodeId > 0) {
            const promoCodeUpdate = hasPromoReservation
                ? db.prepare("SELECT id FROM promo_codes WHERE id = ?").get(promoCodeId)
                : shouldRecordFinancialEffects
                    ? db.prepare(`
                        UPDATE promo_codes
                        SET times_redeemed = times_redeemed + 1,
                            updated_at = ?
                        WHERE id = ?
                    `).run(timestamp, promoCodeId)
                    : { changes: 1 };

            if (!(hasPromoReservation ? promoCodeUpdate : promoCodeUpdate.changes)) {
                missingPromoCode = true;
                nextMetadata.promo_redemption_warning = "promo_code_missing";
            }
        }

        db.prepare(`
            UPDATE orders
            SET status = ?,
                metadata_json = ?,
                items_json = ?,
                updated_at = ?
            WHERE id = ?
        `).run(
            paymentAlreadyRecorded || orderAlreadyInPaidState ? order.status : "paid",
            JSON.stringify(nextMetadata),
            JSON.stringify(nextItems),
            timestamp,
            orderId
        );
    });

    try {
        transaction.immediate();
        if (orderNumber) {
            logger.info(`[inventory] Marked order ${orderNumber} paid${inventoryAlreadyReserved ? " from reserved stock" : ""}`);
        }
        if (missingPromoCode && orderNumber) {
            logger.warn(`[payments] Order ${orderNumber} was paid after its promo code was removed`);
        }
    } catch (error) {
        logger.error(`[inventory] Paid finalization failed for order ${orderNumber || orderId}: ${error.message}`);
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
