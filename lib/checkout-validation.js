const { CHECKOUT_FIELD_LIMITS } = require("./checkout-fields");

function createCheckoutValidationHelpers({
    SHIPPING_OPTIONS,
    normalizeText,
    normalizePromoCode,
    getPreferredPaymentMethod,
}) {
    function validateCheckoutInput(values) {
        const billingSameAsShipping =
            values.billing_same_as_shipping === "1" ||
            values.billing_same_as_shipping === 1 ||
            values.billing_same_as_shipping === true;
        const deliveryMethod = normalizeText(values.delivery_method) || "pickup";

        if (!["ship", "pickup"].includes(deliveryMethod)) {
            throw new Error("Mode de livraison invalide.");
        }

        const paymentMethod = normalizeText(values.payment_method) || getPreferredPaymentMethod(deliveryMethod);
        if (!["card", "transfer", "bitcoin", "cash"].includes(paymentMethod)) {
            throw new Error("Mode de paiement invalide.");
        }

        const form = {
            customer_email: normalizeText(values.customer_email),
            customer_first_name: normalizeText(values.customer_first_name),
            customer_last_name: normalizeText(values.customer_last_name),
            delivery_method: deliveryMethod,
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
            payment_method: paymentMethod,
            promo_code: normalizePromoCode(values.promo_code),
            order_note: normalizeText(values.order_note),
        };

        if (!form.customer_email || !form.customer_first_name || !form.customer_last_name) {
            throw new Error("Les coordonnées de contact sont obligatoires.");
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.customer_email)) {
            throw new Error("L'adresse e-mail est invalide.");
        }

        for (const [field, maxLength] of Object.entries(CHECKOUT_FIELD_LIMITS)) {
            if (form[field].length > maxLength) {
                throw new Error("Une ou plusieurs coordonnées dépassent la longueur autorisée.");
            }
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
        validateCheckoutInput,
    };
}

module.exports = { createCheckoutValidationHelpers };
