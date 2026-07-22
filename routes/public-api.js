const logger = require("../lib/logger");
const { getPublicErrorResponse } = require("../lib/http/public-errors");

function sendJsonAfterSessionSave(req, res, payload, statusCode = 200) {
    req.session.save((error) => {
        if (error) {
            logger.error("session.save_failed", {
                requestId: req.requestId,
                path: req.path,
                error: error.message,
            });
            return res.status(503).json({ error: "Impossible d'enregistrer la session. Veuillez réessayer." });
        }

        return res.status(statusCode).json(payload);
    });
}

async function runStripeRequest(req, operation, request, publicMessage) {
    try {
        return await request();
    } catch (error) {
        logger.error("payments.stripe_request_failed", {
            requestId: req.requestId,
            operation,
            error: error.message,
        });
        throw new Error(publicMessage, { cause: error });
    }
}

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
        requireCheckoutAttemptId,
        completeCheckoutAttempt,
        getStripeDraft,
        clearStripeDraft,
        getPromoCodeOutcome,
        validateCheckoutInput,
        assertPreparedCheckoutOrderMatch,
        prepareCheckoutOrder,
        createOrReuseReservedPreparedCheckoutOrder,
    } = checkout;
    const { createOrReuseStripeIntent, paymentState, isStripeDraftCurrent, createOrderViewToken } = payments;
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
        req.session.save((error) => {
            if (error) {
                logger.error("session.save_failed", {
                    requestId: req.requestId,
                    path: req.path,
                    error: error.message,
                });
                return res.status(503).json({ error: "Impossible d'enregistrer la session. Veuillez réessayer." });
            }

            return res.status(204).end();
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
            sendJsonAfterSessionSave(req, res, {
                paymentIntentId: draft.paymentIntentId,
                clientSecret: draft.clientSecret,
            });
        } catch (error) {
            const publicError = getPublicErrorResponse(
                error,
                "Impossible de préparer le paiement par carte. Veuillez réessayer."
            );
            const statusCode = /Trop de tentatives de paiement carte/i.test(publicError.message)
                ? 429
                : publicError.statusCode;
            if (publicError.internal) {
                logger.error("payments.stripe_intent_failed", {
                    requestId: req.requestId,
                    error: error.message,
                });
            }
            res.status(statusCode).json({ error: publicError.message });
        }
    });

    app.post("/checkout/stripe/prepare", async (req, res) => {
        let createdOrderId = null;

        try {
            if (!paymentState().stripeEnabled) {
                return res.status(400).json({ error: "Le paiement par carte est indisponible." });
            }

            const paymentIntentId = normalizeText((req.body || {}).stripe_payment_intent_id);
            if (!paymentIntentId) {
                return res.status(400).json({ error: "Session de paiement Stripe manquante." });
            }

            const checkoutAttemptId = requireCheckoutAttemptId(req, (req.body || {}).checkout_attempt_id);

            const stripeDraft = getStripeDraft(req);
            if (!stripeDraft || stripeDraft.paymentIntentId !== paymentIntentId) {
                return res.status(400).json({ error: "Session de paiement Stripe expirée. Veuillez actualiser le paiement par carte." });
            }

            const checkoutDetails = validateCheckoutInput(req.body || {});
            checkoutDetails.form.payment_method = "card";
            setCheckoutForm(req, checkoutDetails.form);

            const paymentIntent = await runStripeRequest(
                req,
                "retrieve_prepare_intent",
                () => stripe.paymentIntents.retrieve(paymentIntentId),
                "Impossible de vérifier la session Stripe. Veuillez réessayer."
            );
            if (paymentIntent.status === "canceled") {
                clearStripeDraft(req);
                return res.status(400).json({ error: "Cette session Stripe a été annulée. Veuillez réessayer." });
            }

            const preparedOrder = prepareCheckoutOrder({
                req,
                provider: "stripe",
                providerReference: paymentIntent.id,
                customer: checkoutDetails.customer,
                checkoutDetails,
                idempotencyKey: checkoutAttemptId,
                extraMetadata: {
                    stripePaymentIntentId: paymentIntent.id,
                },
            });

            if (!isStripeDraftCurrent(stripeDraft, {
                paymentIntentId: paymentIntent.id,
                amountCents: preparedOrder.pricing.totalCents,
                deliveryMethod: checkoutDetails.form.delivery_method,
                promoCode: preparedOrder.promoCodeOutcome.code,
                cart: preparedOrder.cart,
            })) {
                return res.status(400).json({ error: "La session de paiement Stripe n'est plus à jour. Veuillez actualiser le paiement par carte." });
            }

            if (paymentIntent.currency !== "chf" || paymentIntent.amount !== preparedOrder.pricing.totalCents) {
                return res.status(400).json({ error: "Le montant Stripe ne correspond plus à la commande." });
            }

            let order = getOrderByProviderReference(db, "stripe", paymentIntent.id);
            let createdOrder = false;
            if (order) {
                assertPreparedCheckoutOrderMatch(preparedOrder, order);
            } else {
                const result = createOrReuseReservedPreparedCheckoutOrder(preparedOrder);
                order = result.order;
                createdOrder = result.createdOrder;
                if (createdOrder) {
                    createdOrderId = order.id;
                    logger.info(`[payments] Prepared Stripe order ${order.order_number} for intent ${paymentIntent.id}`);
                }
            }

            completeCheckoutAttempt(req, checkoutAttemptId, order.id);

            if (createdOrder) {
                await notifyNewOrder(order);
            }

            await runStripeRequest(
                req,
                "update_prepare_intent",
                () => stripe.paymentIntents.update(paymentIntent.id, {
                    receipt_email: checkoutDetails.customer.email,
                    metadata: {
                        source: "recytech-shop",
                        order_number: order.order_number,
                        delivery_method: checkoutDetails.shippingOption.key,
                        promo_code: preparedOrder.promoCodeOutcome.code || "",
                    },
                }),
                "Impossible de finaliser la préparation Stripe. Veuillez réessayer."
            );

            sendJsonAfterSessionSave(req, res, {
                successUrl: `/checkout/success?provider=stripe&payment_intent=${encodeURIComponent(paymentIntent.id)}&order=${encodeURIComponent(order.order_number)}&view=${encodeURIComponent(createOrderViewToken(order))}`,
                orderNumber: order.order_number,
            });
        } catch (error) {
            if (createdOrderId) {
                logger.error(`[payments] Stripe prepare failed after order creation ${createdOrderId}: ${error.message}`);
            }

            const publicError = getPublicErrorResponse(
                error,
                "Impossible de préparer la commande. Veuillez réessayer."
            );
            if (publicError.internal) {
                logger.error("payments.stripe_prepare_failed", {
                    requestId: req.requestId,
                    error: error.message,
                });
            }
            res.status(publicError.statusCode).json({ error: publicError.message });
        }
    });
}

module.exports = { registerPublicApiRoutes, runStripeRequest, sendJsonAfterSessionSave };
