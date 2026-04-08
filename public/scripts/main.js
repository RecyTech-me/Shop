document.querySelectorAll(".flash").forEach((flash) => {
    window.setTimeout(() => {
        flash.classList.add("flash-hidden");
        window.setTimeout(() => {
            flash.parentElement?.classList.add("flash-shell-hidden");
        }, 220);
    }, 5000);
});

const deliveryInputs = document.querySelectorAll('input[name="delivery_method"]');
const paymentMethodInputs = document.querySelectorAll('input[name="payment_method"]');
const billingSameInput = document.querySelector('input[name="billing_same_as_shipping"]');
const shippingSection = document.querySelector('[data-checkout-section="shipping"]');
const pickupSection = document.querySelector('[data-checkout-section="pickup"]');
const billingToggleSection = document.querySelector('[data-checkout-section="billing-toggle"]');
const billingSection = document.querySelector('[data-checkout-section="billing"]');
const cardPaymentSection = document.querySelector('[data-checkout-section="card-payment"]');
const cashPaymentOption = document.querySelector('[data-checkout-section="cash-payment-option"]');
const shippingPrice = document.getElementById("checkout-shipping-price");
const discountRow = document.getElementById("checkout-discount-row");
const discountLabel = document.getElementById("checkout-discount-label");
const discountAmount = document.getElementById("checkout-discount-amount");
const orderTotal = document.getElementById("checkout-order-total");
const optionalPhoneFields = document.querySelectorAll('input[name="shipping_phone"], input[name="billing_phone"]');
const checkoutForm = document.querySelector(".checkout-form");
const stripeMount = document.getElementById("stripe-payment-element");
const stripeMessage = document.getElementById("stripe-payment-message");
let checkoutDraftTimer = null;
let stripeClient = null;
let stripeElements = null;
let stripePaymentElement = null;
let stripeIntentId = "";
let stripeClientSecret = "";
let stripeLoadingPromise = null;
const discountedPaymentMethods = new Set(["bitcoin", "cash"]);

function formatChf(cents) {
    return new Intl.NumberFormat("fr-CH", {
        style: "currency",
        currency: "CHF",
        maximumFractionDigits: 2,
    }).format((cents || 0) / 100);
}

function toggleSection(section, shouldShow) {
    if (!section) {
        return;
    }

    section.hidden = !shouldShow;

    section.querySelectorAll("input, select, textarea").forEach((field) => {
        if (field.dataset.alwaysEnabled === "true") {
            return;
        }

        if (!field.dataset.originalRequired) {
            field.dataset.originalRequired = field.required ? "true" : "false";
        }

        field.disabled = !shouldShow;
        field.required = shouldShow && field.dataset.originalRequired === "true";
    });
}

function showStripeMessage(message, tone = "error") {
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

function getSelectedPaymentMethod() {
    return document.querySelector('input[name="payment_method"]:checked')?.value || "card";
}

function getStripeKey() {
    return checkoutForm?.dataset.stripePublishableKey || "";
}

function selectFirstEnabledPaymentMethod(candidates) {
    for (const value of candidates) {
        const input = document.querySelector(`input[name="payment_method"][value="${value}"]`);
        if (input && !input.disabled) {
            input.checked = true;
            return value;
        }
    }

    return getSelectedPaymentMethod();
}

function ensureValidPaymentMethod(selectedDelivery) {
    const allowedMethods = selectedDelivery === "pickup"
        ? ["card", "transfer", "bitcoin", "cash"]
        : ["card", "transfer", "bitcoin"];
    const currentInput = document.querySelector('input[name="payment_method"]:checked');

    if (currentInput && !currentInput.disabled && allowedMethods.includes(currentInput.value)) {
        return currentInput.value;
    }

    return selectFirstEnabledPaymentMethod(allowedMethods);
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

function syncCheckoutSections() {
    const selectedDelivery = document.querySelector('input[name="delivery_method"]:checked')?.value || "pickup";

    toggleSection(shippingSection, selectedDelivery === "ship");
    toggleSection(pickupSection, selectedDelivery === "pickup");
    toggleSection(cashPaymentOption, selectedDelivery === "pickup");

    if (billingSameInput) {
        const wasDisabled = billingSameInput.disabled;

        if (selectedDelivery === "pickup") {
            billingSameInput.checked = false;
        }

        if (selectedDelivery === "ship" && wasDisabled) {
            billingSameInput.checked = true;
        }

        toggleSection(billingToggleSection, selectedDelivery === "ship");
        billingSameInput.disabled = selectedDelivery !== "ship";
    }

    const shouldShowBilling = selectedDelivery === "pickup" || Boolean(billingSameInput && !billingSameInput.checked);
    toggleSection(billingSection, shouldShowBilling);
    const selectedPayment = ensureValidPaymentMethod(selectedDelivery);
    toggleSection(cardPaymentSection, selectedPayment === "card");

    if (shippingPrice && orderTotal) {
        const deliveryPrice = Number.parseInt(
            selectedDelivery === "ship" ? shippingPrice.dataset.priceShip : shippingPrice.dataset.pricePickup,
            10
        ) || 0;
        const subtotal = Number.parseInt(orderTotal.dataset.subtotal || "0", 10) || 0;
        const discountRate = Number.parseFloat(orderTotal.dataset.discountRate || "0") || 0;
        const discountCents = discountedPaymentMethods.has(selectedPayment) ? Math.round(subtotal * discountRate) : 0;

        shippingPrice.textContent = formatChf(deliveryPrice);
        if (discountRow && discountLabel && discountAmount) {
            discountRow.hidden = discountCents <= 0;
            discountLabel.textContent = getPaymentDiscountLabel(selectedPayment);
            discountAmount.textContent = `-${formatChf(discountCents)}`;
        }
        orderTotal.textContent = formatChf(subtotal + deliveryPrice - discountCents);
    }
}

function buildCheckoutDraftPayload() {
    if (!checkoutForm) {
        return null;
    }

    const payload = {};

    checkoutForm.querySelectorAll("input, select, textarea").forEach((field) => {
        if (!field.name) {
            return;
        }

        if (field.type === "radio") {
            if (field.checked) {
                payload[field.name] = field.value;
            }
            return;
        }

        if (field.type === "checkbox") {
            payload[field.name] = field.checked ? (field.value || "1") : "0";
            return;
        }

        payload[field.name] = field.value;
    });

    return payload;
}

function persistCheckoutDraft() {
    const payload = buildCheckoutDraftPayload();

    if (!payload) {
        return;
    }

    fetch("/checkout/session", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        keepalive: true,
    }).catch(() => {
        // Draft persistence is best-effort and should not block checkout usage.
    });
}

function scheduleCheckoutDraftSave() {
    if (!checkoutForm) {
        return;
    }

    window.clearTimeout(checkoutDraftTimer);
    checkoutDraftTimer = window.setTimeout(persistCheckoutDraft, 250);
}

async function ensureStripeClient() {
    if (stripeClient || !checkoutForm || !getStripeKey()) {
        return stripeClient;
    }

    if (typeof window.Stripe !== "function") {
        throw new Error("Stripe n'a pas pu se charger.");
    }

    stripeClient = window.Stripe(getStripeKey());
    return stripeClient;
}

async function fetchStripeIntent() {
    const response = await fetch(checkoutForm.dataset.stripeIntentUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(buildCheckoutDraftPayload() || {}),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || "Impossible d'initialiser Stripe.");
    }

    return data;
}

async function mountStripePaymentElement(forceRefresh = false) {
    if (!checkoutForm || !cardPaymentSection || cardPaymentSection.hidden || !stripeMount) {
        return;
    }

    if (stripeLoadingPromise && !forceRefresh) {
        return stripeLoadingPromise;
    }

    stripeLoadingPromise = (async () => {
        showStripeMessage("");

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
    })().finally(() => {
        stripeLoadingPromise = null;
    });

    return stripeLoadingPromise;
}

function buildStripeBillingDetails() {
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

async function prepareStripeOrder() {
    const payload = {
        ...(buildCheckoutDraftPayload() || {}),
        stripe_payment_intent_id: stripeIntentId,
    };

    const response = await fetch(checkoutForm.dataset.stripePrepareUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || "Impossible de préparer la commande Stripe.");
    }

    return data;
}

async function submitStripeCheckout(event) {
    event.preventDefault();

    if (!checkoutForm?.reportValidity()) {
        return;
    }

    const submitButton = checkoutForm.querySelector('button[type="submit"]');
    submitButton?.setAttribute("disabled", "disabled");
    showStripeMessage("");

    try {
        await mountStripePaymentElement();
        if (!stripeClient || !stripeElements || !stripeClientSecret || !stripeIntentId) {
            throw new Error("Le formulaire Stripe n'est pas prêt.");
        }

        const prepared = await prepareStripeOrder();
        const { error: submitError } = await stripeElements.submit();
        if (submitError) {
            throw submitError;
        }

        const result = await stripeClient.confirmPayment({
            elements: stripeElements,
            clientSecret: stripeClientSecret,
            confirmParams: {
                payment_method_data: {
                    billing_details: buildStripeBillingDetails(),
                },
            },
            redirect: "if_required",
        });

        if (result.error) {
            throw result.error;
        }

        window.location.assign(prepared.successUrl);
    } catch (error) {
        showStripeMessage(error.message || "Le paiement par carte a échoué.");
        submitButton?.removeAttribute("disabled");
    }
}

deliveryInputs.forEach((input) => {
    input.addEventListener("change", () => {
        syncCheckoutSections();
        if (getSelectedPaymentMethod() === "card") {
            mountStripePaymentElement(true).catch((error) => {
                showStripeMessage(error.message || "Impossible de mettre à jour Stripe.");
            });
        }
        scheduleCheckoutDraftSave();
    });
});

paymentMethodInputs.forEach((input) => {
    input.addEventListener("change", () => {
        syncCheckoutSections();
        if (input.checked && input.value === "card") {
            mountStripePaymentElement().catch((error) => {
                showStripeMessage(error.message || "Impossible de charger Stripe.");
            });
        } else {
            showStripeMessage("");
        }
        scheduleCheckoutDraftSave();
    });
});

if (billingSameInput) {
    billingSameInput.addEventListener("change", () => {
        syncCheckoutSections();
        scheduleCheckoutDraftSave();
    });
}

optionalPhoneFields.forEach((field) => {
    field.dataset.originalRequired = "false";
});

if (checkoutForm) {
    checkoutForm.addEventListener("input", scheduleCheckoutDraftSave);
    checkoutForm.addEventListener("change", scheduleCheckoutDraftSave);
    checkoutForm.addEventListener("submit", (event) => {
        if (getSelectedPaymentMethod() === "card") {
            submitStripeCheckout(event);
        }
    });
}

syncCheckoutSections();

if (getSelectedPaymentMethod() === "card") {
    mountStripePaymentElement().catch((error) => {
        showStripeMessage(error.message || "Impossible de charger Stripe.");
    });
}

document.querySelectorAll("[data-product-gallery]").forEach((gallery) => {
    const mainImage = gallery.querySelector("[data-product-gallery-main]");
    const thumbs = gallery.querySelectorAll("[data-gallery-image]");

    if (!mainImage || !thumbs.length) {
        return;
    }

    thumbs.forEach((thumb) => {
        thumb.addEventListener("click", () => {
            mainImage.src = thumb.dataset.galleryImage || mainImage.src;
            mainImage.alt = thumb.dataset.galleryAlt || mainImage.alt;

            thumbs.forEach((item) => {
                item.classList.toggle("is-active", item === thumb);
            });
        });
    });
});

document.querySelectorAll("[data-product-configurator]").forEach((form) => {
    const selects = [...form.querySelectorAll("select[data-option-group]")];
    const message = form.querySelector("[data-product-configurator-message]");

    if (!selects.length) {
        return;
    }

    let validConfigurations = [];

    try {
        validConfigurations = JSON.parse(form.dataset.validConfigurations || "[]");
    } catch {
        validConfigurations = [];
    }

    if (!Array.isArray(validConfigurations) || !validConfigurations.length) {
        return;
    }

    function currentSelections() {
        return new Map(
            selects
                .map((select) => [select.dataset.optionGroup || "", select.value])
                .filter(([name]) => name)
        );
    }

    function isConfigurationCompatible(configuration, targetGroupName, candidateValue, selections) {
        return configuration.every((selection) => {
            if (selection.name === targetGroupName) {
                return selection.value === candidateValue;
            }

            const selectedValue = selections.get(selection.name);
            return !selectedValue || selectedValue === selection.value;
        });
    }

    function syncConfigurator() {
        const selections = currentSelections();

        selects.forEach((select) => {
            const groupName = select.dataset.optionGroup || "";
            const currentValue = select.value;

            [...select.options].forEach((option) => {
                if (!option.value) {
                    option.disabled = false;
                    return;
                }

                option.disabled = !validConfigurations.some((configuration) =>
                    isConfigurationCompatible(configuration, groupName, option.value, selections)
                );
            });

            if (currentValue && select.selectedOptions[0]?.disabled) {
                select.value = "";
            }
        });

        const finalSelections = currentSelections();
        const hasPartialSelection = selects.some((select) => select.value);
        const hasAnyCompatibleConfiguration = validConfigurations.some((configuration) =>
            configuration.every((selection) => {
                const selectedValue = finalSelections.get(selection.name);
                return !selectedValue || selectedValue === selection.value;
            })
        );

        if (message) {
            if (hasPartialSelection && !hasAnyCompatibleConfiguration) {
                message.hidden = false;
                message.textContent = "Cette combinaison n'est pas disponible.";
            } else {
                message.hidden = true;
                message.textContent = "";
            }
        }
    }

    selects.forEach((select) => {
        select.addEventListener("change", syncConfigurator);
    });

    syncConfigurator();
});

const confirmModal = document.querySelector("[data-confirm-modal]");
const confirmModalTitle = confirmModal?.querySelector("[data-confirm-title]");
const confirmModalMessage = confirmModal?.querySelector("[data-confirm-message]");
const confirmModalSubmit = confirmModal?.querySelector("[data-confirm-submit]");
const confirmModalCancel = confirmModal?.querySelector("[data-confirm-cancel]");
let pendingConfirmForm = null;

function closeConfirmModal() {
    if (!confirmModal) {
        return;
    }

    confirmModal.hidden = true;
    document.body.classList.remove("modal-open");
    pendingConfirmForm = null;
}

if (confirmModal && confirmModalTitle && confirmModalMessage && confirmModalSubmit) {
    document.querySelectorAll("[data-confirm-form]").forEach((form) => {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            pendingConfirmForm = form;
            confirmModalTitle.textContent = form.dataset.confirmTitle || "Confirmer l'action";
            confirmModalMessage.textContent = form.dataset.confirmMessage || "Cette action est irréversible.";
            confirmModalSubmit.textContent = form.dataset.confirmSubmit || "Confirmer";
            confirmModal.hidden = false;
            document.body.classList.add("modal-open");
        });
    });

    confirmModal.addEventListener("click", (event) => {
        if (event.target.hasAttribute("data-confirm-close")) {
            closeConfirmModal();
        }
    });

    confirmModalCancel?.addEventListener("click", closeConfirmModal);

    confirmModalSubmit.addEventListener("click", () => {
        if (!pendingConfirmForm) {
            closeConfirmModal();
            return;
        }

        const form = pendingConfirmForm;
        closeConfirmModal();
        form.submit();
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !confirmModal.hidden) {
            closeConfirmModal();
        }
    });
}
