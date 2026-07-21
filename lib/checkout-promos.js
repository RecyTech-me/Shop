function createCheckoutPromoHelpers({
    PAYMENT_DISCOUNT_RATE,
    formatMoney,
    getPromoCodeByCode,
}) {
    function normalizePromoCode(value) {
        return String(value || "")
            .trim()
            .toUpperCase()
            .replace(/\s+/g, "");
    }

    function todayIsoDate(value = new Date()) {
        const parts = new Intl.DateTimeFormat("en", {
            timeZone: "Europe/Zurich",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(value);
        const dateParts = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    }

    function getPaymentDiscountLabel(paymentMethod) {
        if (paymentMethod === "bitcoin") {
            return "Réduction Bitcoin (-10%)";
        }

        if (paymentMethod === "cash") {
            return "Réduction retrait espèces (-10%)";
        }

        return "";
    }

    function getPromoCodeLabel(promoCode) {
        return `Code promo ${promoCode.code}`;
    }

    function formatPromoCodeDiscount(promoCode) {
        if (!promoCode) {
            return "";
        }

        if (promoCode.discount_type === "percent") {
            return `-${promoCode.discount_percent}%`;
        }

        return `-${formatMoney(promoCode.discount_cents || 0)}`;
    }

    function getPromoCodeStatus(promoCode) {
        if (!promoCode) {
            return "Inconnu";
        }

        if (!promoCode.active) {
            return "Désactivé";
        }

        const today = todayIsoDate();

        if (promoCode.starts_on && today < promoCode.starts_on) {
            return "Planifié";
        }

        if (promoCode.expires_on && today > promoCode.expires_on) {
            return "Expiré";
        }

        if (
            Number.isInteger(promoCode.max_redemptions) &&
            promoCode.max_redemptions > 0 &&
            promoCode.times_redeemed >= promoCode.max_redemptions
        ) {
            return "Épuisé";
        }

        return "Actif";
    }

    function getPromoCodeStatusTone(promoCode) {
        const status = getPromoCodeStatus(promoCode);

        if (status === "Actif") {
            return "success";
        }

        if (status === "Planifié") {
            return "info";
        }

        if (["Expiré", "Épuisé", "Désactivé"].includes(status)) {
            return "muted";
        }

        return "muted";
    }

    function getPromoCodeOutcome(codeValue, subtotalCents) {
        const normalizedCode = normalizePromoCode(codeValue);
        if (!normalizedCode) {
            return {
                code: "",
                promoCode: null,
                discountCents: 0,
                label: "",
                error: "",
            };
        }

        const promoCode = getPromoCodeByCode(normalizedCode);
        if (!promoCode) {
            return {
                code: normalizedCode,
                promoCode: null,
                discountCents: 0,
                label: "",
                error: "Ce code promo n'existe pas.",
            };
        }

        if (!promoCode.active) {
            return {
                code: normalizedCode,
                promoCode,
                discountCents: 0,
                label: "",
                error: "Ce code promo est désactivé.",
            };
        }

        const today = todayIsoDate();

        if (promoCode.starts_on && today < promoCode.starts_on) {
            return {
                code: normalizedCode,
                promoCode,
                discountCents: 0,
                label: "",
                error: "Ce code promo n'est pas encore actif.",
            };
        }

        if (promoCode.expires_on && today > promoCode.expires_on) {
            return {
                code: normalizedCode,
                promoCode,
                discountCents: 0,
                label: "",
                error: "Ce code promo a expiré.",
            };
        }

        if (
            Number.isInteger(promoCode.max_redemptions) &&
            promoCode.max_redemptions > 0 &&
            promoCode.times_redeemed >= promoCode.max_redemptions
        ) {
            return {
                code: normalizedCode,
                promoCode,
                discountCents: 0,
                label: "",
                error: "Ce code promo a déjà atteint sa limite d'utilisation.",
            };
        }

        if ((subtotalCents || 0) < (promoCode.minimum_order_cents || 0)) {
            return {
                code: normalizedCode,
                promoCode,
                discountCents: 0,
                label: "",
                error: `Ce code promo nécessite une commande d'au moins ${formatMoney(promoCode.minimum_order_cents || 0)}.`,
            };
        }

        const discountCents = promoCode.discount_type === "percent"
            ? Math.round((subtotalCents || 0) * ((promoCode.discount_percent || 0) / 100))
            : Math.min(promoCode.discount_cents || 0, subtotalCents || 0);

        if (discountCents <= 0) {
            return {
                code: normalizedCode,
                promoCode,
                discountCents: 0,
                label: "",
                error: "Ce code promo ne peut pas être appliqué à cette commande.",
            };
        }

        return {
            code: normalizedCode,
            promoCode,
            discountCents,
            label: getPromoCodeLabel(promoCode),
            error: "",
        };
    }

    function requirePromoCodeOutcome(codeValue, subtotalCents) {
        const outcome = getPromoCodeOutcome(codeValue, subtotalCents);
        if (outcome.code && outcome.error) {
            throw new Error(outcome.error);
        }

        return outcome;
    }

    function getCheckoutPricing(subtotalCents, shippingOption, paymentMethod, promoCodeOutcome = null) {
        const shippingCents = shippingOption?.priceCents || 0;
        const promoDiscountCents = promoCodeOutcome?.discountCents || 0;
        const remainingSubtotalCents = Math.max((subtotalCents || 0) - promoDiscountCents, 0);
        const paymentDiscountCents = ["bitcoin", "cash"].includes(paymentMethod)
            ? Math.round(remainingSubtotalCents * PAYMENT_DISCOUNT_RATE)
            : 0;
        const discountLines = [];

        if (promoDiscountCents > 0 && promoCodeOutcome?.promoCode) {
            discountLines.push({
                type: "discount",
                code: promoCodeOutcome.promoCode.code,
                label: promoCodeOutcome.label,
                amount_cents: -promoDiscountCents,
            });
        }

        if (paymentDiscountCents > 0) {
            discountLines.push({
                type: "discount",
                label: getPaymentDiscountLabel(paymentMethod),
                amount_cents: -paymentDiscountCents,
            });
        }

        const discountCents = promoDiscountCents + paymentDiscountCents;

        return {
            subtotalCents: subtotalCents || 0,
            shippingCents,
            promoDiscountCents,
            promoDiscountLabel: promoDiscountCents > 0 ? promoCodeOutcome.label : "",
            paymentDiscountCents,
            paymentDiscountLabel: paymentDiscountCents > 0 ? getPaymentDiscountLabel(paymentMethod) : "",
            discountCents,
            discountLabel: discountLines.map((line) => line.label).join(" + "),
            discountLines,
            totalCents: Math.max(0, (subtotalCents || 0) + shippingCents - discountCents),
        };
    }

    return {
        normalizePromoCode,
        formatPromoCodeDiscount,
        getPromoCodeStatus,
        getPromoCodeStatusTone,
        getPromoCodeOutcome,
        requirePromoCodeOutcome,
        getCheckoutPricing,
        getPromoCodeLabel,
        todayIsoDate,
    };
}

module.exports = { createCheckoutPromoHelpers };
