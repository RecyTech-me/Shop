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
        const expected = createOrderViewToken(order);
        const provided = normalizeText(token);

        if (!expected || !provided) {
            return false;
        }

        const expectedBuffer = Buffer.from(expected, "utf8");
        const providedBuffer = Buffer.from(provided, "utf8");

        return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
    }

    return {
        createOrderViewToken,
        verifyOrderViewToken,
    };
}

module.exports = { createOrderViewTokenHelpers };
