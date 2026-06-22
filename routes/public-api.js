function registerPublicApiRoutes(deps) {
    const {
        app,
        db,
        stripe,
        setPublicApiHeaders,
        listPublishedProducts,
        serializePublicProduct,
        setCheckoutForm,
        buildCheckoutDraft,
        getCheckoutForm,
        buildCart,
        setFlash,
        saveSessionAndRedirect,
        clearStripeDraft,
        getPromoCodeOutcome,
        createOrReuseStripeIntent,
        paymentState,
        normalizeText,
        validateCheckoutInput,
        requirePromoCodeOutcome,
        getCheckoutPricing,
        getOrderByProviderReference,
        createOrder,
        notifyNewOrder,
        createOrderViewToken,
    } = deps;

    app.options(["/api/products", "/wp-json/wc/v3/products"], (req, res) => {
        setPublicApiHeaders(res);
        res.status(204).end();
    });

    app.get(["/api/products", "/wp-json/wc/v3/products"], (req, res) => {
        setPublicApiHeaders(res);
        res.json(listPublishedProducts(db).map((product) => serializePublicProduct(req, product)));
    });

    app.post("/checkout/session", (req, res) => {
        setCheckoutForm(req, buildCheckoutDraft(req.body || {}, getCheckoutForm(req)));
        req.session.save(() => {
            res.status(204).end();
        });
    });

    app.post("/checkout/promo", (req, res) => {
        const cart = buildCart(req);
        if (!cart.items.length) {
            setFlash(req, "error", "Votre panier est vide.");
            return saveSessionAndRedirect(req, res, "/cart");
        }

        const nextForm = buildCheckoutDraft(req.body || {}, getCheckoutForm(req));
        setCheckoutForm(req, nextForm);
        clearStripeDraft(req);

        const promoCodeOutcome = getPromoCodeOutcome(nextForm.promo_code, cart.subtotalCents);
        if (!nextForm.promo_code) {
            setFlash(req, "success", "Le code promo a été retiré.");
            return saveSessionAndRedirect(req, res, "/checkout");
        }

        if (promoCodeOutcome.error) {
            setFlash(req, "error", promoCodeOutcome.error);
            return saveSessionAndRedirect(req, res, "/checkout");
        }

        setFlash(req, "success", `${promoCodeOutcome.promoCode.code} a bien été appliqué.`);
        return saveSessionAndRedirect(req, res, "/checkout");
    });

    app.post("/checkout/stripe/intent", async (req, res) => {
        try {
            const draft = await createOrReuseStripeIntent(req, req.body || {});
            req.session.save(() => {
                res.json({
                    paymentIntentId: draft.paymentIntentId,
                    clientSecret: draft.clientSecret,
                });
            });
        } catch (error) {
            const statusCode = /Trop de tentatives de paiement carte/i.test(error.message) ? 429 : 400;
            res.status(statusCode).json({ error: error.message });
        }
    });

    app.post("/checkout/stripe/prepare", async (req, res) => {
        try {
            if (!paymentState().stripeEnabled) {
                return res.status(400).json({ error: "Le paiement par carte est indisponible." });
            }

            const paymentIntentId = normalizeText(req.body.stripe_payment_intent_id);
            if (!paymentIntentId) {
                return res.status(400).json({ error: "Session de paiement Stripe manquante." });
            }

            const checkoutDetails = validateCheckoutInput(req.body || {});
            checkoutDetails.form.payment_method = "card";
            setCheckoutForm(req, checkoutDetails.form);

            const cart = buildCart(req);
            if (!cart.items.length) {
                return res.status(400).json({ error: "Le panier est vide." });
            }

            const promoCodeOutcome = requirePromoCodeOutcome(checkoutDetails.form.promo_code, cart.subtotalCents);
            const pricing = getCheckoutPricing(cart.subtotalCents, checkoutDetails.shippingOption, "card", promoCodeOutcome);
            const amountCents = pricing.totalCents;
            const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

            if (paymentIntent.currency !== "chf" || paymentIntent.amount !== amountCents) {
                return res.status(400).json({ error: "Le montant Stripe ne correspond plus à la commande." });
            }

            let order = getOrderByProviderReference(db, "stripe", paymentIntent.id);
            let createdOrder = false;
            if (!order) {
                order = createOrder(db, {
                    provider: "stripe",
                    provider_reference: paymentIntent.id,
                    customer_name: checkoutDetails.customer.name,
                    customer_email: checkoutDetails.customer.email,
                    amount_cents: amountCents,
                    currency: "CHF",
                    items: cart.items,
                    status: "pending",
                    metadata: {
                        checkout: checkoutDetails.form,
                        delivery: {
                            method: checkoutDetails.shippingOption.key,
                            label: checkoutDetails.shippingOption.label,
                            amount_cents: checkoutDetails.shippingOption.priceCents,
                        },
                        additions: [
                            ...(checkoutDetails.shippingOption.priceCents > 0
                                ? [{
                                    type: "shipping",
                                    label: checkoutDetails.shippingOption.label,
                                    amount_cents: checkoutDetails.shippingOption.priceCents,
                                }]
                                : []),
                            ...pricing.discountLines,
                        ],
                        promo: promoCodeOutcome.promoCode
                            ? {
                                id: promoCodeOutcome.promoCode.id,
                                code: promoCodeOutcome.promoCode.code,
                                description: promoCodeOutcome.promoCode.description,
                                discount_type: promoCodeOutcome.promoCode.discount_type,
                                discount_value: promoCodeOutcome.promoCode.discount_value,
                                discount_cents: promoCodeOutcome.discountCents,
                                label: promoCodeOutcome.label,
                            }
                            : null,
                        stripePaymentIntentId: paymentIntent.id,
                    },
                });
                createdOrder = true;
            }

            if (createdOrder) {
                await notifyNewOrder(order);
            }

            await stripe.paymentIntents.update(paymentIntent.id, {
                receipt_email: checkoutDetails.customer.email,
                metadata: {
                    source: "recytech-shop",
                    order_number: order.order_number,
                    delivery_method: checkoutDetails.shippingOption.key,
                    promo_code: promoCodeOutcome.code || "",
                },
            });

            req.session.save(() => {
                res.json({
                    successUrl: `/checkout/success?provider=stripe&payment_intent=${encodeURIComponent(paymentIntent.id)}&order=${encodeURIComponent(order.order_number)}&view=${encodeURIComponent(createOrderViewToken(order))}`,
                    orderNumber: order.order_number,
                });
            });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
}

module.exports = { registerPublicApiRoutes };
