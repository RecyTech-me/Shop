const { normalizeText, parseOptionalMoneyToCents } = require("./input-utils");

function getOrderPaymentData(order) {
    return order?.metadata?.payment && typeof order.metadata.payment === "object"
        ? order.metadata.payment
        : {};
}

function getOrderReceivedAmountCents(order) {
    const amountCents = Number.parseInt(getOrderPaymentData(order).received_amount_cents, 10);
    return Number.isInteger(amountCents) && amountCents >= 0 ? amountCents : null;
}

function getOrderReceivedDeltaCents(order) {
    const receivedAmountCents = getOrderReceivedAmountCents(order);
    return receivedAmountCents === null ? null : receivedAmountCents - (order.amount_cents || 0);
}

function canEditOrderReceivedAmount(order) {
    return ["cash", "transfer", "manual"].includes(order?.provider);
}

function readReceivedPaymentInput(values, order) {
    const currentPaymentData = getOrderPaymentData(order);
    const nextPaymentData = { ...currentPaymentData };
    const amountCents = parseOptionalMoneyToCents(values.actual_received_chf, "Montant réellement reçu");

    if (amountCents === null) {
        delete nextPaymentData.received_amount_cents;
        delete nextPaymentData.received_amount_recorded_at;
    } else {
        nextPaymentData.received_amount_cents = amountCents;
        nextPaymentData.received_amount_recorded_at = currentPaymentData.received_amount_recorded_at || new Date().toISOString();
    }

    return nextPaymentData;
}

function formatAddressLines(parts) {
    return parts.map(normalizeText).filter(Boolean);
}

function getOrderContactSnapshot(order) {
    const checkout = order.metadata?.checkout || {};
    const shippingLines = formatAddressLines([
        `${checkout.shipping_first_name || checkout.customer_first_name || ""} ${checkout.shipping_last_name || checkout.customer_last_name || ""}`.trim(),
        checkout.shipping_address1,
        [checkout.shipping_postal_code, checkout.shipping_city].filter(Boolean).join(" "),
        checkout.shipping_region,
        checkout.shipping_country,
    ]);
    const billingLines = formatAddressLines([
        `${checkout.billing_first_name || ""} ${checkout.billing_last_name || ""}`.trim(),
        checkout.billing_address1,
        [checkout.billing_postal_code, checkout.billing_city].filter(Boolean).join(" "),
        checkout.billing_region,
        checkout.billing_country,
    ]);
    const phone = checkout.shipping_phone || checkout.billing_phone || "";

    return {
        checkout,
        phone,
        shippingLines,
        billingLines,
    };
}

function buildOrderMailto(order, subjectPrefix = "Commande") {
    const subject = `${subjectPrefix} ${order.order_number}`;
    const body = [
        `Bonjour ${order.customer_name},`,
        "",
        `Nous vous contactons au sujet de votre commande ${order.order_number}.`,
        "",
        "Bien à vous,",
        "RecyTech",
    ].join("\n");

    return `mailto:${encodeURIComponent(order.customer_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function getOrderAdminData(order) {
    return order.metadata?.admin || {};
}

module.exports = {
    getOrderPaymentData,
    getOrderReceivedAmountCents,
    getOrderReceivedDeltaCents,
    canEditOrderReceivedAmount,
    readReceivedPaymentInput,
    getOrderContactSnapshot,
    buildOrderMailto,
    getOrderAdminData,
};
