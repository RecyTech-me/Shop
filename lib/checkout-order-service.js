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

function createCheckoutOrderService({
    db,
    buildCart,
    requirePromoCodeOutcome,
    getCheckoutPricing,
    createOrder,
    reserveOrderInventory = null,
}) {
    function prepareCheckoutOrder({
        req,
        provider,
        customer,
        checkoutDetails,
        providerReference = "",
        extraMetadata = {},
    }) {
        const cart = buildCart(req);
        if (!cart.items.length) {
            throw new Error("Le panier est vide.");
        }

        const promoCodeOutcome = requirePromoCodeOutcome(checkoutDetails.form.promo_code, cart.subtotalCents);
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

        return {
            cart,
            payload,
            pricing,
            promoCodeOutcome,
        };
    }

    function createPreparedCheckoutOrder(preparedOrder) {
        return createOrder(db, preparedOrder.payload);
    }

    function createReservedPreparedCheckoutOrder(preparedOrder) {
        if (!reserveOrderInventory) {
            return createPreparedCheckoutOrder(preparedOrder);
        }

        const transaction = db.transaction(() => {
            const order = createPreparedCheckoutOrder(preparedOrder);
            return reserveOrderInventory(db, order.id);
        });

        return transaction();
    }

    function createCheckoutOrder(input) {
        const preparedOrder = prepareCheckoutOrder(input);
        const shouldReserveInventory = ["stripe", "swissbitcoinpay"].includes(preparedOrder.payload.provider);

        return {
            ...preparedOrder,
            order: shouldReserveInventory
                ? createReservedPreparedCheckoutOrder(preparedOrder)
                : createPreparedCheckoutOrder(preparedOrder),
        };
    }

    return {
        prepareCheckoutOrder,
        createPreparedCheckoutOrder,
        createReservedPreparedCheckoutOrder,
        createCheckoutOrder,
    };
}

module.exports = {
    buildShippingLines,
    checkoutOrderStatus,
    createCheckoutOrderService,
    serializePromoMetadata,
};
