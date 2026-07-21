const crypto = require("node:crypto");
const logger = require("../logger");

const CHECKOUT_ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function getCartSignature(cart) {
    const items = Array.isArray(cart?.items) ? cart.items : [];

    return items
        .map((item) => `${item.item_key}:${item.quantity}:${item.unit_price_cents}`)
        .join("|");
}

function isStripeDraftCurrent(draft, expected) {
    if (!draft || !expected) {
        return false;
    }

    return (
        draft.paymentIntentId === expected.paymentIntentId &&
        Boolean(draft.clientSecret) &&
        draft.amountCents === expected.amountCents &&
        draft.deliveryMethod === expected.deliveryMethod &&
        draft.promoCode === expected.promoCode &&
        draft.cartSignature === getCartSignature(expected.cart)
    );
}

function buildStripeIntentIdempotencyKey(req, draft) {
    const checkoutAttemptId = String(req.session?.checkoutAttemptId || "");
    if (!CHECKOUT_ATTEMPT_PATTERN.test(checkoutAttemptId)) {
        return "";
    }

    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
        amountCents: draft.amountCents,
        deliveryMethod: draft.deliveryMethod,
        promoCode: draft.promoCode,
        cartSignature: draft.cartSignature,
    })).digest("hex").slice(0, 24);

    return `checkout-intent-${checkoutAttemptId}-${fingerprint}`;
}

function createStripeIntentService({
    stripe,
    paymentState,
    buildCart,
    buildCheckoutDraft,
    getCheckoutForm,
    shippingOptions,
    requirePromoCodeOutcome,
    getCheckoutPricing,
    getStripeDraft,
    setStripeDraft,
    getRateLimitState,
    registerAttempt,
}) {
    async function createOrReuseStripeIntent(req, values = {}) {
        if (!paymentState().stripeEnabled) {
            throw new Error("Le paiement par carte est indisponible.");
        }

        const cart = buildCart(req);
        if (!cart.items.length) {
            throw new Error("Le panier est vide.");
        }

        const draftForm = buildCheckoutDraft(values, getCheckoutForm(req));
        const shippingOption = shippingOptions[draftForm.delivery_method] || shippingOptions.pickup;
        const promoCodeOutcome = requirePromoCodeOutcome(draftForm.promo_code, cart.subtotalCents);
        const pricing = getCheckoutPricing(cart.subtotalCents, shippingOption, "card", promoCodeOutcome);
        const amountCents = pricing.totalCents;
        const cartSignature = getCartSignature(cart);
        const draft = getStripeDraft(req);

        if (
            draft &&
            draft.amountCents === amountCents &&
            draft.deliveryMethod === draftForm.delivery_method &&
            draft.promoCode === promoCodeOutcome.code &&
            draft.cartSignature === cartSignature &&
            draft.paymentIntentId &&
            draft.clientSecret
        ) {
            return draft;
        }

        const rateLimitState = getRateLimitState(req);
        if (rateLimitState.blockedUntil > Date.now()) {
            throw new Error("Trop de tentatives de paiement carte. Réessayez dans quelques minutes.");
        }

        registerAttempt(req);

        const idempotencyKey = buildStripeIntentIdempotencyKey(req, {
            amountCents,
            deliveryMethod: draftForm.delivery_method,
            promoCode: promoCodeOutcome.code,
            cartSignature,
        });
        const intentPayload = {
            amount: amountCents,
            currency: "chf",
            payment_method_types: ["card"],
            receipt_email: draftForm.customer_email || undefined,
            metadata: {
                source: "recytech-shop",
                delivery_method: draftForm.delivery_method,
                promo_code: promoCodeOutcome.code || "",
            },
        };
        let paymentIntent;
        try {
            paymentIntent = idempotencyKey
                ? await stripe.paymentIntents.create(intentPayload, { idempotencyKey })
                : await stripe.paymentIntents.create(intentPayload);
        } catch (error) {
            logger.error("payments.stripe_intent_creation_failed", {
                requestId: req.requestId,
                error: error.message,
            });
            throw new Error("Impossible d'initialiser le paiement par carte. Veuillez réessayer.", { cause: error });
        }

        const nextDraft = {
            paymentIntentId: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
            amountCents,
            deliveryMethod: draftForm.delivery_method,
            promoCode: promoCodeOutcome.code,
            cartSignature,
        };

        setStripeDraft(req, nextDraft);
        return nextDraft;
    }

    return { createOrReuseStripeIntent };
}

module.exports = {
    buildStripeIntentIdempotencyKey,
    createStripeIntentService,
    getCartSignature,
    isStripeDraftCurrent,
};
