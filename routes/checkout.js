const logger = require("../lib/logger");
const { getPublicErrorResponse } = require("../lib/http/public-errors");

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
        abandonCheckoutAttempt,
        getCheckoutPricing,
        getCheckoutForm,
        getOrCreateCheckoutAttemptId,
        getCompletedCheckoutOrderId,
        requireCheckoutAttemptId,
        completeCheckoutAttempt,
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
        getOrderById,
        getOrderByNumber,
    } = orders;
    const { notifyNewOrder } = mail;

    app.get("/checkout", (req, res) => {
        if (!res.locals.cart.items.length) {
            setFlash(req, "error", "Votre panier est vide.");
            return res.redirect("/cart");
        }

        const checkoutForm = getCheckoutForm(req);
        const checkoutAttemptId = getOrCreateCheckoutAttemptId(req);
        const shippingOption = SHIPPING_OPTIONS[checkoutForm.delivery_method] || SHIPPING_OPTIONS.pickup;
        const promoCodeOutcome = getPromoCodeOutcome(checkoutForm.promo_code, res.locals.cart.subtotalCents);
        const pricing = getCheckoutPricing(res.locals.cart.subtotalCents, shippingOption, checkoutForm.payment_method, promoCodeOutcome.error ? null : promoCodeOutcome);

        render(res, "checkout", {
            title: "Paiement",
            checkoutForm,
            checkoutAttemptId,
            pricing,
            promoCodeOutcome,
            shippingOptions: SHIPPING_OPTIONS,
            shippingCostCents: shippingOption.priceCents,
            orderTotalCents: pricing.totalCents,
        });
    });

    app.post("/checkout", async (req, res) => {
        try {
            const checkoutAttemptId = requireCheckoutAttemptId(req, req.body.checkout_attempt_id);
            const checkoutDetails = validateCheckout(req);
            setCheckoutForm(req, checkoutDetails.form);

            const completedOrderId = getCompletedCheckoutOrderId(req, checkoutAttemptId);
            if (completedOrderId) {
                const completedOrder = getOrderById(db, completedOrderId);
                const expectedProvider = checkoutDetails.form.payment_method === "bitcoin"
                    ? "swissbitcoinpay"
                    : checkoutDetails.form.payment_method;
                if (!completedOrder || completedOrder.provider !== expectedProvider) {
                    throw new Error("Cette tentative de commande n'est plus valide.");
                }

                if (completedOrder.provider === "swissbitcoinpay" && completedOrder.metadata?.checkoutUrl) {
                    return saveSessionAndRedirect(req, res, completedOrder.metadata.checkoutUrl);
                }

                clearCheckoutForm(req);
                setCartItems(req, []);
                return saveSessionAndRedirect(req, res, `/checkout/success?provider=${encodeURIComponent(expectedProvider)}&order=${encodeURIComponent(completedOrder.order_number)}&view=${encodeURIComponent(createOrderViewToken(completedOrder))}`);
            }

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

                const { order, createdOrder } = createCheckoutOrder({
                    req,
                    provider: "swissbitcoinpay",
                    customer: checkoutDetails.customer,
                    checkoutDetails,
                    idempotencyKey: checkoutAttemptId,
                });

                if (!createdOrder) {
                    if (order.metadata?.checkoutUrl) {
                        return saveSessionAndRedirect(req, res, order.metadata.checkoutUrl);
                    }

                    throw new Error("La préparation du paiement bitcoin est déjà en cours. Veuillez patienter puis réessayer.");
                }

                try {
                    const invoice = await createSwissBitcoinPayInvoice(order, req);
                    logger.info(`[payments] Created Swiss Bitcoin Pay invoice ${invoice.id} for order ${order.order_number}`);

                    updateOrderProviderReference(db, order.id, invoice.id, {
                        checkoutUrl: invoice.checkoutUrl || "",
                        lightningInvoice: invoice.pr || "",
                        onChainAddress: invoice.onChainAddr || "",
                    });
                    completeCheckoutAttempt(req, checkoutAttemptId, order.id);
                    await notifyNewOrder(order);

                    return saveSessionAndRedirect(req, res, invoice.checkoutUrl);
                } catch (error) {
                    logger.error(`[payments] Swiss Bitcoin Pay invoice creation failed for order ${order.order_number}: ${error.message}`);
                    const outcomeKnownFailed = error.providerOutcomeKnownFailed === true;
                    updateOrderStatus(db, order.id, outcomeKnownFailed ? "failed" : "pending", {
                        swissBitcoinPayInvoiceError: error.message,
                        swissBitcoinPayInvoiceOutcome: outcomeKnownFailed ? "rejected" : "unknown",
                    });
                    if (outcomeKnownFailed) {
                        abandonCheckoutAttempt(req, checkoutAttemptId);
                        throw new Error("Impossible d'initialiser le paiement bitcoin. Veuillez réessayer.", { cause: error });
                    }

                    throw new Error("L'état du paiement bitcoin est incertain. La réservation est conservée pour vérification.", { cause: error });
                }
            }

            if (checkoutDetails.form.payment_method === "cash") {
                const { order: cashOrder, createdOrder } = createCheckoutOrder({
                    req,
                    provider: "cash",
                    customer: checkoutDetails.customer,
                    checkoutDetails,
                    idempotencyKey: checkoutAttemptId,
                });
                completeCheckoutAttempt(req, checkoutAttemptId, cashOrder.id);
                if (createdOrder) {
                    await notifyNewOrder(cashOrder);
                }
                clearCheckoutForm(req);
                setCartItems(req, []);
                return saveSessionAndRedirect(req, res, `/checkout/success?provider=cash&order=${encodeURIComponent(cashOrder.order_number)}&view=${encodeURIComponent(createOrderViewToken(cashOrder))}`);
            }

            const { order: transferOrder, createdOrder } = createCheckoutOrder({
                req,
                provider: "transfer",
                customer: checkoutDetails.customer,
                checkoutDetails,
                idempotencyKey: checkoutAttemptId,
            });
            completeCheckoutAttempt(req, checkoutAttemptId, transferOrder.id);
            if (createdOrder) {
                await notifyNewOrder(transferOrder);
            }
            clearCheckoutForm(req);
            setCartItems(req, []);
            return saveSessionAndRedirect(req, res, `/checkout/success?provider=transfer&order=${encodeURIComponent(transferOrder.order_number)}&view=${encodeURIComponent(createOrderViewToken(transferOrder))}`);
        } catch (error) {
            const publicError = getPublicErrorResponse(
                error,
                "Impossible de traiter la commande. Veuillez réessayer."
            );
            if (publicError.internal) {
                logger.error("checkout.order_failed", {
                    requestId: req.requestId,
                    error: error.message,
                });
            }
            setFlash(req, "error", publicError.message);
            return saveSessionAndRedirect(req, res, "/checkout");
        }
    });

    app.get("/checkout/success", async (req, res) => {
        let order = null;
        let visibleOrder = null;

        try {
            if (req.query.provider === "stripe" && req.query.payment_intent && stripe) {
                const paymentIntentId = String(req.query.payment_intent || "").trim();
                order = getOrderByProviderReference(db, "stripe", paymentIntentId);
                const authorizedOrder = order && verifyOrderViewToken(order, req.query.view)
                    ? order
                    : null;

                if (authorizedOrder) {
                    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

                    if (paymentIntent.id !== paymentIntentId) {
                        throw new Error("Stripe returned a mismatched PaymentIntent.");
                    }

                    if (paymentIntent.status === "succeeded") {
                        order = markOrderPaid(db, order.id, {
                            stripePaymentIntentId: paymentIntent.id,
                            paymentStatus: paymentIntent.status,
                        });
                        setCartItems(req, []);
                    } else if (["processing", "requires_capture"].includes(paymentIntent.status)) {
                        order = updateOrderStatus(db, order.id, "pending", {
                            stripePaymentIntentId: paymentIntent.id,
                            paymentStatus: paymentIntent.status,
                        });
                    }

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
            logger.error("payments.checkout_status_verification_failed", {
                requestId: req.requestId,
                provider: req.query.provider,
                error: error.message,
            });
            setFlash(req, "error", "Paiement terminé avec un statut incertain. Contactez-nous si vous avez été débité.");
        }

        if (visibleOrder) {
            clearCheckoutForm(req);
            clearStripeDraft(req);
        }

        render(res, "success", {
            title: "Commande",
            order: visibleOrder,
        });
    });

    app.get("/checkout/cancel", (req, res) => {
        const requestedOrder = req.query.order ? getOrderByNumber(db, req.query.order) : null;
        const visibleOrder = requestedOrder && verifyOrderViewToken(requestedOrder, req.query.view)
            ? requestedOrder
            : null;

        render(res, "cancel", {
            title: "Paiement annulé",
            order: visibleOrder,
        });
    });
}

module.exports = { registerCheckoutRoutes };
