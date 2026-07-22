const crypto = require("crypto");

const CHECKOUT_ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function checkoutOrderStatus(provider) {
    return provider === "transfer" ? "awaiting_transfer" : "pending";
}

function buildShippingLines(shippingOption) {
    if (!shippingOption.priceCents) {
        return [];
    }

    return [{
        type: "shipping",
        label: shippingOption.label,
        amount_cents: shippingOption.priceCents,
    }];
}

function serializePromoMetadata(promoCodeOutcome) {
    if (!promoCodeOutcome.promoCode) {
        return null;
    }

    return {
        id: promoCodeOutcome.promoCode.id,
        code: promoCodeOutcome.promoCode.code,
        description: promoCodeOutcome.promoCode.description,
        discount_type: promoCodeOutcome.promoCode.discount_type,
        discount_value: promoCodeOutcome.promoCode.discount_value,
        discount_cents: promoCodeOutcome.discountCents,
        label: promoCodeOutcome.label,
    };
}

function fingerprintCheckoutPayload(payload) {
    return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function promoOutcomeFromExistingOrder(existingOrder, requestedCode) {
    const promo = existingOrder?.metadata?.promo;
    const normalizedRequestedCode = String(requestedCode || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!promo || !normalizedRequestedCode || normalizedRequestedCode !== promo.code) {
        return null;
    }

    return {
        code: promo.code,
        promoCode: {
            id: promo.id,
            code: promo.code,
            description: promo.description,
            discount_type: promo.discount_type,
            discount_value: promo.discount_value,
        },
        discountCents: promo.discount_cents,
        label: promo.label,
        error: "",
    };
}

function createCheckoutOrderService({
    db,
    buildCart,
    requirePromoCodeOutcome,
    getCheckoutPricing,
    createOrder,
    getOrderByIdempotencyKey = null,
    reserveOrderInventory = null,
}) {
    function prepareCheckoutOrder({
        req,
        provider,
        customer,
        checkoutDetails,
        providerReference = "",
        idempotencyKey = "",
        extraMetadata = {},
    }) {
        const cart = buildCart(req);
        if (!cart.items.length) {
            throw new Error("Le panier est vide.");
        }

        let existingOrder = null;
        if (idempotencyKey) {
            if (!CHECKOUT_ATTEMPT_PATTERN.test(idempotencyKey)) {
                throw new Error("Cette tentative de commande a expiré. Veuillez réessayer.");
            }

            existingOrder = getOrderByIdempotencyKey
                ? getOrderByIdempotencyKey(db, idempotencyKey)
                : null;
        }

        const promoCodeOutcome = promoOutcomeFromExistingOrder(
            existingOrder,
            checkoutDetails.form.promo_code,
        ) || requirePromoCodeOutcome(checkoutDetails.form.promo_code, cart.subtotalCents);
        const pricing = getCheckoutPricing(
            cart.subtotalCents,
            checkoutDetails.shippingOption,
            checkoutDetails.form.payment_method,
            promoCodeOutcome
        );
        const payload = {
            provider,
            customer_name: customer.name,
            customer_email: customer.email,
            amount_cents: pricing.totalCents,
            currency: "CHF",
            items: cart.items,
            status: checkoutOrderStatus(provider),
            metadata: {
                checkout: checkoutDetails.form,
                delivery: {
                    method: checkoutDetails.shippingOption.key,
                    label: checkoutDetails.shippingOption.label,
                    amount_cents: checkoutDetails.shippingOption.priceCents,
                },
                additions: [
                    ...buildShippingLines(checkoutDetails.shippingOption),
                    ...pricing.discountLines,
                ],
                promo: serializePromoMetadata(promoCodeOutcome),
                ...extraMetadata,
            },
        };

        if (providerReference) {
            payload.provider_reference = providerReference;
        }

        if (idempotencyKey) {
            payload.idempotency_key = idempotencyKey;
            payload.metadata.checkout_idempotency_fingerprint = fingerprintCheckoutPayload(payload);
        }

        return {
            cart,
            payload,
            pricing,
            promoCodeOutcome,
            existingOrder,
        };
    }

    function createPreparedCheckoutOrder(preparedOrder) {
        return createOrder(db, preparedOrder.payload);
    }

    function assertPreparedCheckoutOrderMatch(preparedOrder, existingOrder) {
        const expectedFingerprint = preparedOrder.payload.metadata.checkout_idempotency_fingerprint;
        if (existingOrder.metadata?.checkout_idempotency_fingerprint !== expectedFingerprint) {
            throw new Error("Cette tentative de commande a déjà été utilisée avec un contenu différent.");
        }

        return existingOrder;
    }

    function findMatchingCheckoutOrder(preparedOrder) {
        const idempotencyKey = preparedOrder.payload.idempotency_key;
        if (!idempotencyKey || !getOrderByIdempotencyKey) {
            return null;
        }

        const existingOrder = preparedOrder.existingOrder || getOrderByIdempotencyKey(db, idempotencyKey);
        return existingOrder
            ? assertPreparedCheckoutOrderMatch(preparedOrder, existingOrder)
            : null;
    }

    function createOrReuseReservedPreparedCheckoutOrder(preparedOrder) {
        const createOrReuse = () => {
            const existingOrder = findMatchingCheckoutOrder(preparedOrder);
            if (existingOrder) {
                return { order: existingOrder, createdOrder: false };
            }

            const createdOrder = createPreparedCheckoutOrder(preparedOrder);
            const order = reserveOrderInventory
                ? reserveOrderInventory(db, createdOrder.id)
                : createdOrder;
            return { order, createdOrder: true };
        };
        const execute = reserveOrderInventory ? db.transaction(createOrReuse) : createOrReuse;

        try {
            return reserveOrderInventory ? execute.immediate() : execute();
        } catch (error) {
            const existingOrder = findMatchingCheckoutOrder(preparedOrder);
            if (existingOrder) {
                return { order: existingOrder, createdOrder: false };
            }

            throw error;
        }
    }

    function createCheckoutOrder(input) {
        const preparedOrder = prepareCheckoutOrder(input);
        const result = createOrReuseReservedPreparedCheckoutOrder(preparedOrder);

        return {
            ...preparedOrder,
            ...result,
        };
    }

    return {
        assertPreparedCheckoutOrderMatch,
        prepareCheckoutOrder,
        createOrReuseReservedPreparedCheckoutOrder,
        createCheckoutOrder,
    };
}

module.exports = {
    buildShippingLines,
    checkoutOrderStatus,
    createCheckoutOrderService,
    fingerprintCheckoutPayload,
    serializePromoMetadata,
};
