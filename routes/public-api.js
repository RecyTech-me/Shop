function registerPublicApiRoutes(deps) {
    const {
        app,
        db,
        providers,
        http,
        text,
        publicProducts,
        cart,
        checkout,
        payments,
        orders,
        mail,
    } = deps;
    const { stripe } = providers;
    const { setFlash, saveSessionAndRedirect } = http;
    const { normalizeText } = text;
    const { setPublicApiHeaders, serializePublicProduct } = publicProducts;
    const { buildCart } = cart;
    const {
        setCheckoutForm,
        buildCheckoutDraft,
        getCheckoutForm,
        clearStripeDraft,
        getPromoCodeOutcome,
        validateCheckoutInput,
        prepareCheckoutOrder,
        createPreparedCheckoutOrder,
    } = checkout;
    const { createOrReuseStripeIntent, paymentState, createOrderViewToken } = payments;
    const { getOrderByProviderReference } = orders;
    const { notifyNewOrder } = mail;

    app.options(["/api/products", "/wp-json/wc/v3/products"], (req, res) => {
        setPublicApiHeaders(res);
        res.status(204).end();
    });

    app.get(["/api/products", "/wp-json/wc/v3/products"], (req, res) => {
        setPublicApiHeaders(res);
        res.json(deps.products.listPublishedProducts(db).map((product) => serializePublicProduct(req, product)));
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

            const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
            const preparedOrder = prepareCheckoutOrder({
                req,
                provider: "stripe",
                providerReference: paymentIntent.id,
                customer: checkoutDetails.customer,
                checkoutDetails,
                extraMetadata: {
                    stripePaymentIntentId: paymentIntent.id,
                },
            });

            if (paymentIntent.currency !== "chf" || paymentIntent.amount !== preparedOrder.pricing.totalCents) {
                return res.status(400).json({ error: "Le montant Stripe ne correspond plus à la commande." });
            }

            let order = getOrderByProviderReference(db, "stripe", paymentIntent.id);
            let createdOrder = false;
            if (!order) {
                order = createPreparedCheckoutOrder(preparedOrder);
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
                    promo_code: preparedOrder.promoCodeOutcome.code || "",
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
