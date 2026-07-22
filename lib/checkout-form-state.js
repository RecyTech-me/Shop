const { CHECKOUT_FIELD_LIMITS, CHECKOUT_TEXT_FIELDS } = require("./checkout-fields");

function createCheckoutFormStateHelpers({
    normalizeText,
    normalizePromoCode,
    getAllowedPaymentMethods,
    getPreferredPaymentMethod,
}) {
    function normalizeCheckoutFormState(form) {
        const nextForm = {
            ...form,
        };

        for (const field of CHECKOUT_TEXT_FIELDS) {
            nextForm[field] = normalizeText(nextForm[field]).slice(0, CHECKOUT_FIELD_LIMITS[field]);
        }
        nextForm.promo_code = normalizePromoCode(nextForm.promo_code)
            .slice(0, CHECKOUT_FIELD_LIMITS.promo_code);

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

    function buildCheckoutDraft(values, currentForm = getDefaultCheckoutForm()) {
        const draft = {
            ...currentForm,
        };

        for (const field of CHECKOUT_TEXT_FIELDS) {
            if (values[field] !== undefined) {
                draft[field] = normalizeText(values[field]).slice(0, CHECKOUT_FIELD_LIMITS[field]);
            }
        }

        if (["ship", "pickup"].includes(values.delivery_method)) {
            draft.delivery_method = values.delivery_method;
        }

        if (["card", "transfer", "bitcoin", "cash"].includes(values.payment_method)) {
            draft.payment_method = values.payment_method;
        }

        if (values.promo_code !== undefined) {
            draft.promo_code = normalizePromoCode(values.promo_code)
                .slice(0, CHECKOUT_FIELD_LIMITS.promo_code);
        }

        if (values.billing_same_as_shipping !== undefined) {
            draft.billing_same_as_shipping = values.billing_same_as_shipping === "1" ? "1" : "0";
        }

        return normalizeCheckoutFormState(draft);
    }

    return {
        buildCheckoutDraft,
        getDefaultCheckoutForm,
        normalizeCheckoutFormState,
    };
}

module.exports = { createCheckoutFormStateHelpers };
