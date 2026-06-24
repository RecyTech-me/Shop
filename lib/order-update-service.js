const { ORDER_STATUS_OPTIONS } = require("./shop-formatters");

function createOrderUpdateService(deps) {
    const {
        db,
        normalizeText,
        normalizeOrderDateTimeField,
        getOrderAdminData,
        canEditOrderReceivedAmount,
        readReceivedPaymentInput,
        getOrderPaymentData,
        markOrderPaid,
        updateOrderRecord,
    } = deps;

    function readOrderUpdateInput(order, values) {
        const status = normalizeText(values.status);
        if (!ORDER_STATUS_OPTIONS.some((option) => option.value === status)) {
            throw new Error("Statut de commande invalide.");
        }

        const currentAdminData = getOrderAdminData(order);
        const admin = {
            ...currentAdminData,
            internal_note: normalizeText(values.internal_note),
            customer_note: normalizeText(values.customer_note),
            fulfillment_note: normalizeText(values.fulfillment_note),
            carrier: normalizeText(values.carrier),
            tracking_number: normalizeText(values.tracking_number),
            pickup_details: normalizeText(values.pickup_details),
        };
        const payment = canEditOrderReceivedAmount(order)
            ? readReceivedPaymentInput(values, order)
            : getOrderPaymentData(order);

        return {
            status,
            createdAt: normalizeOrderDateTimeField(values.order_created_at, order.created_at),
            metadata: {
                admin,
                payment,
            },
        };
    }

    function updateOrderFromInput(order, values) {
        const input = readOrderUpdateInput(order, values);

        if (input.status === "paid" && order.status !== "paid") {
            const paidOrder = markOrderPaid(db, order.id, {
                ...input.metadata,
            });

            return updateOrderRecord(db, paidOrder.id, {
                created_at: input.createdAt,
                metadata: input.metadata,
            });
        }

        return updateOrderRecord(db, order.id, {
            status: input.status,
            created_at: input.createdAt,
            metadata: input.metadata,
        });
    }

    return {
        readOrderUpdateInput,
        updateOrderFromInput,
    };
}

module.exports = { createOrderUpdateService };
