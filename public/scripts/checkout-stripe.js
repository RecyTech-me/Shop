export function createStripeCheckoutController({
    checkoutForm,
    cardPaymentSection,
    stripeMount,
    stripeMessage,
    csrfToken,
    buildCheckoutDraftPayload,
    beforeSubmit = async () => {},
    afterSubmitFailure = () => {},
}) {
    let stripeClient = null;
    let stripeElements = null;
    let stripePaymentElement = null;
    let stripeIntentId = "";
    let stripeClientSecret = "";
    let stripeLoadingPromise = null;
    let stripeRefreshPromise = null;

    function showMessage(message, tone = "error") {
        if (!stripeMessage) {
            return;
        }

        if (!message) {
            stripeMessage.hidden = true;
            stripeMessage.textContent = "";
            stripeMessage.dataset.tone = "";
            return;
        }

        stripeMessage.hidden = false;
        stripeMessage.textContent = message;
        stripeMessage.dataset.tone = tone;
    }

    function getStripeKey() {
        return checkoutForm?.dataset.stripePublishableKey || "";
    }

    async function ensureStripeClient() {
        if (stripeClient || !checkoutForm || !getStripeKey()) {
            return stripeClient;
        }

        if (typeof window.Stripe !== "function") {
            throw new Error("Stripe n'a pas pu se charger.");
        }

        stripeClient = window.Stripe(getStripeKey(), { locale: "fr" });
        return stripeClient;
    }

    async function fetchStripeIntent() {
        const response = await fetch(checkoutForm.dataset.stripeIntentUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
            },
            body: JSON.stringify(buildCheckoutDraftPayload() || {}),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || "Impossible d'initialiser Stripe.");
        }

        return data;
    }

    async function mountPaymentElement(forceRefresh = false) {
        if (!checkoutForm || !cardPaymentSection || cardPaymentSection.hidden || !stripeMount) {
            return;
        }

        if (stripeLoadingPromise && !forceRefresh) {
            return stripeLoadingPromise;
        }

        if (stripeLoadingPromise && forceRefresh) {
            if (!stripeRefreshPromise) {
                stripeRefreshPromise = stripeLoadingPromise
                    .catch(() => {})
                    .then(() => mountPaymentElement(true))
                    .finally(() => {
                        stripeRefreshPromise = null;
                    });
            }

            return stripeRefreshPromise;
        }

        const loadingPromise = (async () => {
            showMessage("");

            const client = await ensureStripeClient();
            if (!client) {
                return;
            }

            if (forceRefresh && stripePaymentElement) {
                stripePaymentElement.unmount();
                stripePaymentElement = null;
                stripeElements = null;
                stripeIntentId = "";
                stripeClientSecret = "";
            }

            const intent = await fetchStripeIntent();
            if (intent.clientSecret === stripeClientSecret && stripePaymentElement) {
                return;
            }

            stripeIntentId = intent.paymentIntentId;
            stripeClientSecret = intent.clientSecret;

            if (stripePaymentElement) {
                stripePaymentElement.unmount();
            }

            stripeMount.innerHTML = "";
            stripeElements = client.elements({
                clientSecret: stripeClientSecret,
                appearance: {
                    theme: "stripe",
                    variables: {
                        colorPrimary: "#244c38",
                        colorBackground: "#ffffff",
                        colorText: "#243227",
                        colorDanger: "#b42318",
                        fontFamily: "Inter, Segoe UI, sans-serif",
                        borderRadius: "12px",
                    },
                },
            });
            stripePaymentElement = stripeElements.create("payment", {
                layout: "tabs",
                defaultValues: {
                    billingDetails: {
                        email: document.querySelector('input[name="customer_email"]')?.value || "",
                        name: [
                            document.querySelector('input[name="customer_first_name"]')?.value || "",
                            document.querySelector('input[name="customer_last_name"]')?.value || "",
                        ].join(" ").trim(),
                    },
                },
            });
            stripePaymentElement.mount("#stripe-payment-element");
        })();
        stripeLoadingPromise = loadingPromise;
        loadingPromise.finally(() => {
            if (stripeLoadingPromise === loadingPromise) {
                stripeLoadingPromise = null;
            }
        }).catch(() => {});

        return loadingPromise;
    }

    function buildBillingDetails() {
        const payload = buildCheckoutDraftPayload() || {};
        const usesShipping = payload.delivery_method === "ship" && payload.billing_same_as_shipping === "1";
        const name = [
            payload.customer_first_name || payload.billing_first_name || "",
            payload.customer_last_name || payload.billing_last_name || "",
        ].join(" ").trim();

        return {
            email: payload.customer_email || "",
            name,
            phone: usesShipping ? (payload.shipping_phone || "") : (payload.billing_phone || ""),
            address: {
                country: "CH",
                line1: usesShipping ? (payload.shipping_address1 || "") : (payload.billing_address1 || ""),
                postal_code: usesShipping ? (payload.shipping_postal_code || "") : (payload.billing_postal_code || ""),
                city: usesShipping ? (payload.shipping_city || "") : (payload.billing_city || ""),
                state: usesShipping ? (payload.shipping_region || "") : (payload.billing_region || ""),
            },
        };
    }

    async function prepareOrder() {
        const payload = {
            ...(buildCheckoutDraftPayload() || {}),
            stripe_payment_intent_id: stripeIntentId,
        };

        const response = await fetch(checkoutForm.dataset.stripePrepareUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
            },
            body: JSON.stringify(payload),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || "Impossible de préparer la commande Stripe.");
        }

        return data;
    }

    async function submitCheckout(event) {
        event.preventDefault();

        if (!checkoutForm?.reportValidity()) {
            return;
        }

        const submitButton = checkoutForm.querySelector('button[type="submit"]');
        submitButton?.setAttribute("disabled", "disabled");
        showMessage("");

        try {
            await beforeSubmit();
            await mountPaymentElement();
            if (!stripeClient || !stripeElements || !stripeClientSecret || !stripeIntentId) {
                throw new Error("Le formulaire Stripe n'est pas prêt.");
            }

            const { error: submitError } = await stripeElements.submit();
            if (submitError) {
                throw submitError;
            }

            const prepared = await prepareOrder();
            const result = await stripeClient.confirmPayment({
                elements: stripeElements,
                clientSecret: stripeClientSecret,
                confirmParams: {
                    payment_method_data: {
                        billing_details: buildBillingDetails(),
                    },
                },
                redirect: "if_required",
            });

            if (result.error) {
                throw result.error;
            }

            window.location.assign(prepared.successUrl);
        } catch (error) {
            afterSubmitFailure();
            showMessage(error.message || "Le paiement par carte a échoué.");
            submitButton?.removeAttribute("disabled");
        }
    }

    return {
        mountPaymentElement,
        showMessage,
        submitCheckout,
    };
}
