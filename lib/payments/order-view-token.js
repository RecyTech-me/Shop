const crypto = require("crypto");
const { normalizeText } = require("../input-utils");

function createOrderViewTokenHelpers(secret) {
    function createOrderViewToken(order) {
        if (!order || !secret) {
            return "";
        }

        return crypto
            .createHmac("sha256", secret)
            .update([order.order_number, order.customer_email, order.amount_cents, order.provider].join("|"))
            .digest("base64url");
    }

    function verifyOrderViewToken(order, token) {
        const provided = normalizeText(token);
        if (!order || !secret || !provided) {
            return false;
        }

        const providedBuffer = Buffer.from(provided, "utf8");
        const numbers = [order.order_number];
        if (order.legacy_order_number) {
            numbers.push(order.legacy_order_number);
        }
        if (Array.isArray(order.metadata?.merged_order_numbers)) {
            numbers.push(...order.metadata.merged_order_numbers);
        }
        return numbers.some((orderNumber) => {
            const expectedBuffer = Buffer.from(createOrderViewToken({ ...order, order_number: orderNumber }), "utf8");
            return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
        });
    }

    return {
        createOrderViewToken,
        verifyOrderViewToken,
    };
}

module.exports = { createOrderViewTokenHelpers };
