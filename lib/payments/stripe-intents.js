function getCartSignature(cart) {
    return cart.items
        .map((item) => `${item.item_key}:${item.quantity}:${item.unit_price_cents}`)
        .join("|");
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

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: "chf",
            payment_method_types: ["card"],
            receipt_email: draftForm.customer_email || undefined,
            metadata: {
                source: "recytech-shop",
                delivery_method: draftForm.delivery_method,
                promo_code: promoCodeOutcome.code || "",
            },
        });

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

module.exports = { createStripeIntentService };
