const { createCheckoutFormStateHelpers } = require("./checkout-form-state");
const { createCheckoutPaymentMethodHelpers } = require("./checkout-payment-methods");
const { createCheckoutPromoHelpers } = require("./checkout-promos");
const { createCheckoutSessionStateHelpers } = require("./checkout-session-state");
const { createCheckoutValidationHelpers } = require("./checkout-validation");

function createCheckoutStateHelpers(options) {
    const {
        SHIPPING_OPTIONS,
        PAYMENT_DISCOUNT_RATE,
        formatMoney,
        getPromoCodeByCode,
        normalizeText,
        paymentState,
    } = options;

    const paymentMethodHelpers = createCheckoutPaymentMethodHelpers({
        paymentState,
    });
    const promoHelpers = createCheckoutPromoHelpers({
        PAYMENT_DISCOUNT_RATE,
        formatMoney,
        getPromoCodeByCode,
    });
    const formHelpers = createCheckoutFormStateHelpers({
        normalizeText,
        normalizePromoCode: promoHelpers.normalizePromoCode,
        getAllowedPaymentMethods: paymentMethodHelpers.getAllowedPaymentMethods,
        getPreferredPaymentMethod: paymentMethodHelpers.getPreferredPaymentMethod,
    });
    const sessionHelpers = createCheckoutSessionStateHelpers({
        getDefaultCheckoutForm: formHelpers.getDefaultCheckoutForm,
        normalizeCheckoutFormState: formHelpers.normalizeCheckoutFormState,
    });
    const validationHelpers = createCheckoutValidationHelpers({
        SHIPPING_OPTIONS,
        normalizeText,
        normalizePromoCode: promoHelpers.normalizePromoCode,
        getPreferredPaymentMethod: paymentMethodHelpers.getPreferredPaymentMethod,
    });

    return {
        getAllowedPaymentMethods: paymentMethodHelpers.getAllowedPaymentMethods,
        getPreferredPaymentMethod: paymentMethodHelpers.getPreferredPaymentMethod,
        normalizePromoCode: promoHelpers.normalizePromoCode,
        formatPromoCodeDiscount: promoHelpers.formatPromoCodeDiscount,
        getPromoCodeStatus: promoHelpers.getPromoCodeStatus,
        getPromoCodeStatusTone: promoHelpers.getPromoCodeStatusTone,
        getPromoCodeOutcome: promoHelpers.getPromoCodeOutcome,
        requirePromoCodeOutcome: promoHelpers.requirePromoCodeOutcome,
        getCheckoutPricing: promoHelpers.getCheckoutPricing,
        getCheckoutForm: sessionHelpers.getCheckoutForm,
        buildCheckoutDraft: formHelpers.buildCheckoutDraft,
        setCheckoutForm: sessionHelpers.setCheckoutForm,
        clearCheckoutForm: sessionHelpers.clearCheckoutForm,
        getStripeDraft: sessionHelpers.getStripeDraft,
        setStripeDraft: sessionHelpers.setStripeDraft,
        clearStripeDraft: sessionHelpers.clearStripeDraft,
        validateCheckoutInput: validationHelpers.validateCheckoutInput,
        getPromoCodeLabel: promoHelpers.getPromoCodeLabel,
    };
}

module.exports = { createCheckoutStateHelpers };
