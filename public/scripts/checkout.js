import { csrfToken } from "./shared.js";
import { calculateCheckoutSummary } from "./checkout-calculations.js";
import {
    buildCheckoutDraftPayload,
    createCheckoutDraftSaver,
    formatChf,
    toggleSection,
} from "./checkout-form-state.js";
import { createStripeCheckoutController } from "./checkout-stripe.js";

export function initCheckout() {
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
    const promoRow = document.getElementById("checkout-promo-row");
    const promoLabel = document.getElementById("checkout-promo-label");
    const promoAmount = document.getElementById("checkout-promo-amount");
    const paymentDiscountRow = document.getElementById("checkout-payment-discount-row");
    const paymentDiscountLabel = document.getElementById("checkout-payment-discount-label");
    const paymentDiscountAmount = document.getElementById("checkout-payment-discount-amount");
    const orderTotal = document.getElementById("checkout-order-total");
    const optionalPhoneFields = document.querySelectorAll('input[name="shipping_phone"], input[name="billing_phone"]');
    const checkoutForm = document.querySelector(".checkout-form");
    const stripeMount = document.getElementById("stripe-payment-element");
    const stripeMessage = document.getElementById("stripe-payment-message");
    const getCheckoutDraftPayload = () => buildCheckoutDraftPayload(checkoutForm);
    const draftSaver = createCheckoutDraftSaver({ checkoutForm, csrfToken });
    const stripeCheckout = createStripeCheckoutController({
        checkoutForm,
        cardPaymentSection,
        stripeMount,
        stripeMessage,
        csrfToken,
        buildCheckoutDraftPayload: getCheckoutDraftPayload,
    });

    function getSelectedPaymentMethod() {
        return document.querySelector('input[name="payment_method"]:checked')?.value || "card";
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
            const summary = calculateCheckoutSummary({
                selectedDelivery,
                selectedPayment,
                pricePickupCents: shippingPrice.dataset.pricePickup,
                priceShipCents: shippingPrice.dataset.priceShip,
                subtotalCents: orderTotal.dataset.subtotal,
                promoDiscountCents: orderTotal.dataset.promoDiscount,
                promoLabel: orderTotal.dataset.promoLabel,
                paymentDiscountRate: orderTotal.dataset.paymentDiscountRate,
            });

            shippingPrice.textContent = formatChf(summary.deliveryPriceCents);
            if (promoRow && promoLabel && promoAmount) {
                promoRow.hidden = !summary.promoVisible;
                promoLabel.textContent = summary.promoLabel;
                promoAmount.textContent = `-${formatChf(summary.promoDiscountCents)}`;
            }
            if (paymentDiscountRow && paymentDiscountLabel && paymentDiscountAmount) {
                paymentDiscountRow.hidden = !summary.paymentDiscountVisible;
                paymentDiscountLabel.textContent = summary.paymentDiscountLabel;
                paymentDiscountAmount.textContent = `-${formatChf(summary.paymentDiscountCents)}`;
            }
            orderTotal.textContent = formatChf(summary.totalCents);
        }
    }

    deliveryInputs.forEach((input) => {
        input.addEventListener("change", () => {
            syncCheckoutSections();
            if (getSelectedPaymentMethod() === "card") {
                stripeCheckout.mountPaymentElement(true).catch((error) => {
                    stripeCheckout.showMessage(error.message || "Impossible de mettre à jour Stripe.");
                });
            }
            draftSaver.schedule();
        });
    });

    paymentMethodInputs.forEach((input) => {
        input.addEventListener("change", () => {
            syncCheckoutSections();
            if (input.checked && input.value === "card") {
                stripeCheckout.mountPaymentElement().catch((error) => {
                    stripeCheckout.showMessage(error.message || "Impossible de charger Stripe.");
                });
            } else {
                stripeCheckout.showMessage("");
            }
            draftSaver.schedule();
        });
    });

    if (billingSameInput) {
        billingSameInput.addEventListener("change", () => {
            syncCheckoutSections();
            draftSaver.schedule();
        });
    }

    optionalPhoneFields.forEach((field) => {
        field.dataset.originalRequired = "false";
    });

    if (checkoutForm) {
        checkoutForm.addEventListener("input", draftSaver.schedule);
        checkoutForm.addEventListener("change", draftSaver.schedule);
        checkoutForm.addEventListener("submit", (event) => {
            if (event.submitter?.hasAttribute("data-skip-stripe-submit")) {
                return;
            }

            if (getSelectedPaymentMethod() === "card") {
                stripeCheckout.submitCheckout(event);
            }
        });
    }

    syncCheckoutSections();

    if (getSelectedPaymentMethod() === "card") {
        stripeCheckout.mountPaymentElement().catch((error) => {
            stripeCheckout.showMessage(error.message || "Impossible de charger Stripe.");
        });
    }
}
