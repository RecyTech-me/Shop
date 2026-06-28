const logger = require("../lib/logger");

function registerCheckoutRoutes(deps) {
    const {
        app,
        db,
        providers,
        formatters,
        http,
        cart,
        checkout,
        forms,
        payments,
        orders,
        mail,
    } = deps;
    const { stripe } = providers;
    const { SHIPPING_OPTIONS } = formatters;
    const { render, setFlash, saveSessionAndRedirect } = http;
    const { setCartItems } = cart;
    const {
        getCheckoutPricing,
        getCheckoutForm,
        getPromoCodeOutcome,
        setCheckoutForm,
        clearCheckoutForm,
        clearStripeDraft,
        createCheckoutOrder,
    } = checkout;
    const { validateCheckout } = forms;
    const {
        paymentState,
        createSwissBitcoinPayInvoice,
        createOrderViewToken,
        fetchSwissBitcoinPayInvoice,
        mapSwissBitcoinPayStatus,
        verifyOrderViewToken,
    } = payments;
    const {
        updateOrderProviderReference,
        getOrderByProviderReference,
        markOrderPaid,
        updateOrderStatus,
        getOrderByNumber,
    } = orders;
    const { notifyNewOrder } = mail;

    app.get("/checkout", (req, res) => {
        if (!res.locals.cart.items.length) {
            setFlash(req, "error", "Votre panier est vide.");
            return res.redirect("/cart");
        }

        const checkoutForm = getCheckoutForm(req);
        const shippingOption = SHIPPING_OPTIONS[checkoutForm.delivery_method] || SHIPPING_OPTIONS.pickup;
        const promoCodeOutcome = getPromoCodeOutcome(checkoutForm.promo_code, res.locals.cart.subtotalCents);
        const pricing = getCheckoutPricing(res.locals.cart.subtotalCents, shippingOption, checkoutForm.payment_method, promoCodeOutcome.error ? null : promoCodeOutcome);

        render(res, "checkout", {
            title: "Paiement",
            checkoutForm,
            pricing,
            promoCodeOutcome,
            shippingOptions: SHIPPING_OPTIONS,
            shippingCostCents: shippingOption.priceCents,
            orderTotalCents: pricing.totalCents,
        });
    });

    app.post("/checkout", async (req, res) => {
        try {
            const checkoutDetails = validateCheckout(req);
            setCheckoutForm(req, checkoutDetails.form);

            if (checkoutDetails.form.payment_method === "card") {
                if (!paymentState().stripeEnabled) {
                    setFlash(req, "error", "Le paiement par carte est indisponible.");
                    return saveSessionAndRedirect(req, res, "/checkout");
                }

                setFlash(req, "error", "Le paiement par carte se finalise directement sur cette page.");
                return saveSessionAndRedirect(req, res, "/checkout");
            }

            if (checkoutDetails.form.payment_method === "bitcoin") {
                if (!paymentState().bitcoinEnabled) {
                    setFlash(req, "error", "Le paiement bitcoin est indisponible.");
                    return saveSessionAndRedirect(req, res, "/checkout");
                }

                const { order } = createCheckoutOrder({
                    req,
                    provider: "swissbitcoinpay",
                    customer: checkoutDetails.customer,
                    checkoutDetails,
                });

                try {
                    await notifyNewOrder(order);
                    const invoice = await createSwissBitcoinPayInvoice(order, req);
                    logger.info(`[payments] Created Swiss Bitcoin Pay invoice ${invoice.id} for order ${order.order_number}`);

                    updateOrderProviderReference(db, order.id, invoice.id, {
                        checkoutUrl: invoice.checkoutUrl || "",
                        lightningInvoice: invoice.pr || "",
                        onChainAddress: invoice.onChainAddr || "",
                    });

                    return saveSessionAndRedirect(req, res, invoice.checkoutUrl);
                } catch (error) {
                    logger.error(`[payments] Swiss Bitcoin Pay invoice creation failed for order ${order.order_number}: ${error.message}`);
                    updateOrderStatus(db, order.id, "failed", {
                        swissBitcoinPayInvoiceError: error.message,
                    });
                    throw error;
                }
            }

            if (checkoutDetails.form.payment_method === "cash") {
                const { order: cashOrder } = createCheckoutOrder({
                    req,
                    provider: "cash",
                    customer: checkoutDetails.customer,
                    checkoutDetails,
                });
                await notifyNewOrder(cashOrder);
                clearCheckoutForm(req);
                setCartItems(req, []);
                return saveSessionAndRedirect(req, res, `/checkout/success?provider=cash&order=${encodeURIComponent(cashOrder.order_number)}&view=${encodeURIComponent(createOrderViewToken(cashOrder))}`);
            }

            const { order: transferOrder } = createCheckoutOrder({
                req,
                provider: "transfer",
                customer: checkoutDetails.customer,
                checkoutDetails,
            });
            await notifyNewOrder(transferOrder);
            clearCheckoutForm(req);
            setCartItems(req, []);
            return saveSessionAndRedirect(req, res, `/checkout/success?provider=transfer&order=${encodeURIComponent(transferOrder.order_number)}&view=${encodeURIComponent(createOrderViewToken(transferOrder))}`);
        } catch (error) {
            setFlash(req, "error", error.message);
            return saveSessionAndRedirect(req, res, "/checkout");
        }
    });

    app.get("/checkout/success", async (req, res) => {
        let order = null;
        let visibleOrder = null;

        try {
            if (req.query.provider === "stripe" && req.query.payment_intent && stripe) {
                const paymentIntent = await stripe.paymentIntents.retrieve(req.query.payment_intent);
                order = getOrderByProviderReference(db, "stripe", paymentIntent.id);

                if (order && paymentIntent.status === "succeeded") {
                    order = markOrderPaid(db, order.id, {
                        stripePaymentIntentId: paymentIntent.id,
                        paymentStatus: paymentIntent.status,
                    });
                    setCartItems(req, []);
                } else if (order && ["processing", "requires_capture"].includes(paymentIntent.status)) {
                    order = updateOrderStatus(db, order.id, "pending", {
                        stripePaymentIntentId: paymentIntent.id,
                        paymentStatus: paymentIntent.status,
                    });
                }

                if (order && verifyOrderViewToken(order, req.query.view)) {
                    visibleOrder = order;
                }
            }

            if (req.query.provider === "swissbitcoinpay" && req.query.order) {
                order = getOrderByNumber(db, req.query.order);

                if (order && verifyOrderViewToken(order, req.query.view)) {
                    visibleOrder = order;
                }

                if (visibleOrder?.provider_reference && paymentState().bitcoinEnabled) {
                    const invoice = await fetchSwissBitcoinPayInvoice(order.provider_reference);
                    const nextStatus = mapSwissBitcoinPayStatus(invoice);
                    const metadata = {
                        swissBitcoinPayInvoiceId: invoice.id,
                        invoiceStatus: invoice.status || "",
                        paymentMethod: invoice.paymentMethod || "",
                        txId: invoice.txId || "",
                    };

                    if (nextStatus === "paid") {
                        order = markOrderPaid(db, order.id, metadata);
                        visibleOrder = order;
                        setCartItems(req, []);
                    } else {
                        order = updateOrderStatus(db, order.id, nextStatus, metadata);
                        visibleOrder = order;
                    }
                }
            }

            if (req.query.provider === "transfer" && req.query.order) {
                order = getOrderByNumber(db, req.query.order);
                if (order && verifyOrderViewToken(order, req.query.view)) {
                    visibleOrder = order;
                    setCartItems(req, []);
                }
            }

            if (req.query.provider === "cash" && req.query.order) {
                order = getOrderByNumber(db, req.query.order);
                if (order && verifyOrderViewToken(order, req.query.view)) {
                    visibleOrder = order;
                    setCartItems(req, []);
                }
            }
        } catch (error) {
            setFlash(req, "error", `Paiement terminé avec un statut incertain : ${error.message}`);
        }

        clearCheckoutForm(req);
        clearStripeDraft(req);

        render(res, "success", {
            title: "Commande",
            order: visibleOrder,
        });
    });

    app.get("/checkout/cancel", (req, res) => {
        render(res, "cancel", {
            title: "Paiement annulé",
            order: req.query.order ? getOrderByNumber(db, req.query.order) : null,
        });
    });
}

module.exports = { registerCheckoutRoutes };
