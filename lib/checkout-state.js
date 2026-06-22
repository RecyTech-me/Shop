function createCheckoutStateHelpers(options) {
    const {
        SHIPPING_OPTIONS,
        PAYMENT_DISCOUNT_RATE,
        formatMoney,
        getPromoCodeByCode,
        normalizeText,
        paymentState,
    } = options;

    function getAllowedPaymentMethods(deliveryMethod) {
        const methods = [];
        const state = paymentState();

        if (state.stripeEnabled) {
            methods.push("card");
        }

        methods.push("transfer");

        if (state.bitcoinEnabled) {
            methods.push("bitcoin");
        }

        if (deliveryMethod === "pickup") {
            methods.push("cash");
        }

        return methods;
    }

    function getPreferredPaymentMethod(deliveryMethod) {
        return getAllowedPaymentMethods(deliveryMethod)[0] || "transfer";
    }

    function normalizePromoCode(value) {
        return String(value || "")
            .trim()
            .toUpperCase()
            .replace(/\s+/g, "");
    }

    function todayIsoDate() {
        const value = new Date();
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
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

    function normalizeCheckoutFormState(form) {
        const nextForm = {
            ...form,
        };

        if (!["ship", "pickup"].includes(nextForm.delivery_method)) {
            nextForm.delivery_method = "ship";
        }

        const allowedPaymentMethods = getAllowedPaymentMethods(nextForm.delivery_method);
        if (!allowedPaymentMethods.includes(nextForm.payment_method)) {
            nextForm.payment_method = getPreferredPaymentMethod(nextForm.delivery_method);
        }

        if (nextForm.delivery_method === "pickup") {
            nextForm.billing_same_as_shipping = "0";
        }

        return nextForm;
    }

    function getDefaultCheckoutForm() {
        return {
            customer_email: "",
            customer_first_name: "",
            customer_last_name: "",
            delivery_method: "ship",
            pickup_location: "recytech-center",
            shipping_country: "Suisse",
            shipping_address1: "",
            shipping_postal_code: "",
            shipping_city: "",
            shipping_region: "Neuchâtel",
            shipping_phone: "",
            billing_same_as_shipping: "1",
            billing_country: "Suisse",
            billing_first_name: "",
            billing_last_name: "",
            billing_address1: "",
            billing_postal_code: "",
            billing_city: "",
            billing_region: "Neuchâtel",
            billing_phone: "",
            payment_method: getPreferredPaymentMethod("ship"),
            promo_code: "",
            order_note: "",
        };
    }

    function getCheckoutForm(req) {
        return normalizeCheckoutFormState({
            ...getDefaultCheckoutForm(),
            ...(req.session.checkoutForm || {}),
        });
    }

    function buildCheckoutDraft(values, currentForm = getDefaultCheckoutForm()) {
        const draft = {
            ...currentForm,
        };

        const textFields = [
            "customer_email",
            "customer_first_name",
            "customer_last_name",
            "pickup_location",
            "shipping_country",
            "shipping_address1",
            "shipping_postal_code",
            "shipping_city",
            "shipping_region",
            "shipping_phone",
            "billing_country",
            "billing_first_name",
            "billing_last_name",
            "billing_address1",
            "billing_postal_code",
            "billing_city",
            "billing_region",
            "billing_phone",
            "order_note",
        ];

        for (const field of textFields) {
            if (values[field] !== undefined) {
                draft[field] = normalizeText(values[field]);
            }
        }

        if (["ship", "pickup"].includes(values.delivery_method)) {
            draft.delivery_method = values.delivery_method;
        }

        if (["card", "transfer", "bitcoin", "cash"].includes(values.payment_method)) {
            draft.payment_method = values.payment_method;
        }

        if (values.promo_code !== undefined) {
            draft.promo_code = normalizePromoCode(values.promo_code);
        }

        if (values.billing_same_as_shipping !== undefined) {
            draft.billing_same_as_shipping = values.billing_same_as_shipping === "1" ? "1" : "0";
        }

        return normalizeCheckoutFormState(draft);
    }

    function setCheckoutForm(req, values) {
        req.session.checkoutForm = values;
    }

    function clearCheckoutForm(req) {
        delete req.session.checkoutForm;
    }

    function getStripeDraft(req) {
        return req.session.stripeDraft || null;
    }

    function setStripeDraft(req, draft) {
        req.session.stripeDraft = draft;
    }

    function clearStripeDraft(req) {
        delete req.session.stripeDraft;
    }

    function validateCheckoutInput(values) {
        const billingSameAsShipping =
            values.billing_same_as_shipping === "1" ||
            values.billing_same_as_shipping === 1 ||
            values.billing_same_as_shipping === true;

        const form = {
            customer_email: normalizeText(values.customer_email),
            customer_first_name: normalizeText(values.customer_first_name),
            customer_last_name: normalizeText(values.customer_last_name),
            delivery_method: normalizeText(values.delivery_method) || "pickup",
            pickup_location: normalizeText(values.pickup_location) || "recytech-center",
            shipping_country: normalizeText(values.shipping_country) || "Suisse",
            shipping_address1: normalizeText(values.shipping_address1),
            shipping_postal_code: normalizeText(values.shipping_postal_code),
            shipping_city: normalizeText(values.shipping_city),
            shipping_region: normalizeText(values.shipping_region) || "Neuchâtel",
            shipping_phone: normalizeText(values.shipping_phone),
            billing_same_as_shipping: billingSameAsShipping ? "1" : "0",
            billing_country: normalizeText(values.billing_country) || "Suisse",
            billing_first_name: normalizeText(values.billing_first_name),
            billing_last_name: normalizeText(values.billing_last_name),
            billing_address1: normalizeText(values.billing_address1),
            billing_postal_code: normalizeText(values.billing_postal_code),
            billing_city: normalizeText(values.billing_city),
            billing_region: normalizeText(values.billing_region) || "Neuchâtel",
            billing_phone: normalizeText(values.billing_phone),
            payment_method: normalizeText(values.payment_method) || getPreferredPaymentMethod(normalizeText(values.delivery_method) || "pickup"),
            promo_code: normalizePromoCode(values.promo_code),
            order_note: normalizeText(values.order_note),
        };

        if (!form.customer_email || !form.customer_first_name || !form.customer_last_name) {
            throw new Error("Les coordonnées de contact sont obligatoires.");
        }

        if (!["ship", "pickup"].includes(form.delivery_method)) {
            form.delivery_method = "pickup";
        }

        if (!["card", "transfer", "bitcoin", "cash"].includes(form.payment_method)) {
            form.payment_method = getPreferredPaymentMethod(form.delivery_method);
        }

        if (form.payment_method === "cash" && form.delivery_method !== "pickup") {
            throw new Error("Le paiement en espèces est disponible uniquement pour le retrait.");
        }

        if (form.delivery_method === "pickup") {
            form.billing_same_as_shipping = "0";
        }

        if (form.delivery_method === "ship") {
            const shippingFields = [
                form.shipping_address1,
                form.shipping_postal_code,
                form.shipping_city,
            ];

            if (shippingFields.some((value) => !value)) {
                throw new Error("L'adresse de livraison est incomplète.");
            }
        }

        if (form.billing_same_as_shipping === "0") {
            const billingFields = [
                form.billing_first_name,
                form.billing_last_name,
                form.billing_address1,
                form.billing_postal_code,
                form.billing_city,
            ];

            if (billingFields.some((value) => !value)) {
                throw new Error("L'adresse de facturation est incomplète.");
            }
        } else {
            form.billing_country = form.shipping_country;
            form.billing_first_name = form.customer_first_name;
            form.billing_last_name = form.customer_last_name;
            form.billing_address1 = form.shipping_address1;
            form.billing_postal_code = form.shipping_postal_code;
            form.billing_city = form.shipping_city;
            form.billing_region = form.shipping_region;
            form.billing_phone = form.shipping_phone;
        }

        const shippingOption = SHIPPING_OPTIONS[form.delivery_method] || SHIPPING_OPTIONS.pickup;
        const customerName = `${form.customer_first_name} ${form.customer_last_name}`.trim();

        return {
            form,
            customer: {
                name: customerName,
                email: form.customer_email,
            },
            shippingOption,
        };
    }

    return {
        getAllowedPaymentMethods,
        getPreferredPaymentMethod,
        normalizePromoCode,
        formatPromoCodeDiscount,
        getPromoCodeStatus,
        getPromoCodeStatusTone,
        getPromoCodeOutcome,
        requirePromoCodeOutcome,
        getCheckoutPricing,
        getCheckoutForm,
        buildCheckoutDraft,
        setCheckoutForm,
        clearCheckoutForm,
        getStripeDraft,
        setStripeDraft,
        clearStripeDraft,
        validateCheckoutInput,
        getPromoCodeLabel,
    };
}

module.exports = { createCheckoutStateHelpers };
