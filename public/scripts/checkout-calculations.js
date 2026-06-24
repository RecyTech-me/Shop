const DISCOUNTED_PAYMENT_METHODS = new Set(["bitcoin", "cash"]);

function integerCents(value) {
    return Math.max(0, Number.parseInt(value, 10) || 0);
}

function percentageRate(value) {
    return Math.max(0, Number.parseFloat(value) || 0);
}

export function getPaymentDiscountLabel(paymentMethod) {
    if (paymentMethod === "bitcoin") {
        return "Réduction Bitcoin (-10%)";
    }

    if (paymentMethod === "cash") {
        return "Réduction retrait espèces (-10%)";
    }

    return "";
}

export function calculateCheckoutSummary({
    selectedDelivery,
    selectedPayment,
    pricePickupCents,
    priceShipCents,
    subtotalCents,
    promoDiscountCents,
    promoLabel,
    paymentDiscountRate,
}) {
    const deliveryPriceCents = selectedDelivery === "ship"
        ? integerCents(priceShipCents)
        : integerCents(pricePickupCents);
    const subtotal = integerCents(subtotalCents);
    const promoDiscount = integerCents(promoDiscountCents);
    const paymentDiscountBaseCents = Math.max(subtotal - promoDiscount, 0);
    const paymentDiscountCents = DISCOUNTED_PAYMENT_METHODS.has(selectedPayment)
        ? Math.round(paymentDiscountBaseCents * percentageRate(paymentDiscountRate))
        : 0;

    return {
        deliveryPriceCents,
        paymentDiscountCents,
        paymentDiscountLabel: getPaymentDiscountLabel(selectedPayment),
        paymentDiscountVisible: paymentDiscountCents > 0,
        promoDiscountCents: promoDiscount,
        promoLabel: promoLabel || "Code promo",
        promoVisible: promoDiscount > 0,
        totalCents: Math.max(subtotal + deliveryPriceCents - promoDiscount - paymentDiscountCents, 0),
    };
}
