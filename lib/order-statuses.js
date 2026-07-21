const PAID_ORDER_STATUSES = Object.freeze([
    "paid",
    "processing",
    "ready_for_pickup",
    "shipped",
    "completed",
]);

const INVENTORY_HOLDING_ORDER_STATUSES = Object.freeze([
    "pending",
    "awaiting_transfer",
]);

const paidOrderStatusSet = new Set(PAID_ORDER_STATUSES);
const inventoryHoldingStatusSet = new Set(INVENTORY_HOLDING_ORDER_STATUSES);

function isPaidOrderStatus(status) {
    return paidOrderStatusSet.has(status);
}

function isInventoryHoldingOrderStatus(status) {
    return inventoryHoldingStatusSet.has(status);
}

function hasRecordedPayment(order) {
    return Boolean(order?.metadata?.payment_recorded_at)
        || isPaidOrderStatus(order?.status)
        || order?.status === "refunded";
}

function assertAdminOrderStatusTransition(order, nextStatus) {
    if (order?.status === "refunded" && nextStatus !== "refunded") {
        throw new Error("Une commande remboursée ne peut pas revenir à un autre statut.");
    }

    if (nextStatus === "refunded" && !hasRecordedPayment(order)) {
        throw new Error("Une commande non payée ne peut pas être marquée comme remboursée.");
    }

    if (
        hasRecordedPayment(order)
        && nextStatus !== "refunded"
        && !isPaidOrderStatus(nextStatus)
    ) {
        throw new Error("Une commande payée ne peut pas revenir à un statut non payé.");
    }
}

module.exports = {
    INVENTORY_HOLDING_ORDER_STATUSES,
    PAID_ORDER_STATUSES,
    assertAdminOrderStatusTransition,
    hasRecordedPayment,
    isInventoryHoldingOrderStatus,
    isPaidOrderStatus,
};
