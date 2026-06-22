function registerCheckoutRoutes(deps) {
    const {
        app,
        db,
        stripe,
        SHIPPING_OPTIONS,
        render,
        setFlash,
        saveSessionAndRedirect,
        buildCart,
        requirePromoCodeOutcome,
        getCheckoutPricing,
        createOrder,
        getCheckoutForm,
        getPromoCodeOutcome,
        paymentState,
        setCheckoutForm,
        validateCheckout,
        createSwissBitcoinPayInvoice,
        updateOrderProviderReference,
        clearCheckoutForm,
        setCartItems,
        createOrderViewToken,
        sendNewOrderNotification,
        fetchSwissBitcoinPayInvoice,
        mapSwissBitcoinPayStatus,
        getOrderByProviderReference,
        markOrderPaid,
        updateOrderStatus,
        getOrderByNumber,
        verifyOrderViewToken,
        clearStripeDraft,
    } = deps;

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

    function createOrderFromSessionCart(req, provider, customer, checkoutDetails) {
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
        const shippingLine = checkoutDetails.shippingOption.priceCents > 0
            ? [{
                type: "shipping",
                label: checkoutDetails.shippingOption.label,
                amount_cents: checkoutDetails.shippingOption.priceCents,
            }]
            : [];

        return createOrder(db, {
            provider,
            customer_name: customer.name,
            customer_email: customer.email,
            amount_cents: pricing.totalCents,
            currency: "CHF",
            items: cart.items,
            status: provider === "transfer" ? "awaiting_transfer" : "pending",
            metadata: {
                checkout: checkoutDetails.form,
                delivery: {
                    method: checkoutDetails.shippingOption.key,
                    label: checkoutDetails.shippingOption.label,
                    amount_cents: checkoutDetails.shippingOption.priceCents,
                },
                additions: [...shippingLine, ...pricing.discountLines],
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
            },
        });
    }

    async function notifyNewOrder(order) {
        try {
            await sendNewOrderNotification(order);
        } catch (error) {
            console.error(`Order notification email failed for ${order.order_number}: ${error.message}`);
        }
    }

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

                const order = createOrderFromSessionCart(req, "swissbitcoinpay", checkoutDetails.customer, checkoutDetails);
                await notifyNewOrder(order);
                const invoice = await createSwissBitcoinPayInvoice(order, req);

                updateOrderProviderReference(db, order.id, invoice.id, {
                    checkoutUrl: invoice.checkoutUrl || "",
                    lightningInvoice: invoice.pr || "",
                    onChainAddress: invoice.onChainAddr || "",
                });

                return saveSessionAndRedirect(req, res, invoice.checkoutUrl);
            }

            if (checkoutDetails.form.payment_method === "cash") {
                const cashOrder = createOrderFromSessionCart(req, "cash", checkoutDetails.customer, checkoutDetails);
                await notifyNewOrder(cashOrder);
                clearCheckoutForm(req);
                setCartItems(req, []);
                return saveSessionAndRedirect(req, res, `/checkout/success?provider=cash&order=${encodeURIComponent(cashOrder.order_number)}&view=${encodeURIComponent(createOrderViewToken(cashOrder))}`);
            }

            const transferOrder = createOrderFromSessionCart(req, "transfer", checkoutDetails.customer, checkoutDetails);
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
