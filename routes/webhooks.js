const express = require("express");
const logger = require("../lib/logger");
const { createRequestId } = require("../lib/http/request-id");

function orderLogId(order) {
    return order?.order_number || `#${order?.id}`;
}

function stripeFailureOrderStatus(eventType) {
    return eventType === "payment_intent.canceled" ? "failed" : "pending";
}

function findSwissBitcoinPayOrder({
    db,
    invoice,
    invoiceId,
    getOrderByProviderReference,
    getOrderByNumber,
    updateOrderProviderReference,
    normalizeText,
    nowIso = () => new Date().toISOString(),
}) {
    const referencedOrder = getOrderByProviderReference(db, "swissbitcoinpay", invoiceId);
    if (referencedOrder) {
        return { order: referencedOrder, recovered: false };
    }

    const orderNumber = normalizeText(invoice.extra?.orderNumber || invoice.invoice?.extra?.orderNumber);
    const recoverableOrder = orderNumber ? getOrderByNumber(db, orderNumber) : null;
    if (
        recoverableOrder?.provider !== "swissbitcoinpay"
        || (recoverableOrder.provider_reference && recoverableOrder.provider_reference !== invoiceId)
    ) {
        return { order: null, recovered: false };
    }

    const recoveredOrder = updateOrderProviderReference(db, recoverableOrder.id, invoiceId, {
        swissBitcoinPayReferenceRecoveredAt: nowIso(),
    });

    return { order: recoveredOrder, recovered: Boolean(recoveredOrder) };
}

function registerWebhookRoutes(deps) {
    const {
        app,
        db,
        providers,
        repositories,
        payments,
        text,
    } = deps;
    const { stripe, stripeWebhookSecret } = providers;
    const {
        getOrderByProviderReference,
        getOrderByNumber,
        updateOrderProviderReference,
        markOrderPaid,
        updateOrderStatus,
    } = repositories;
    const { verifySwissBitcoinPayWebhook, mapSwissBitcoinPayStatus } = payments;
    const { normalizeText } = text;

    app.use("/webhooks", (req, res, next) => {
        req.requestId = req.requestId || createRequestId(req);
        res.set("X-Request-Id", req.requestId);
        res.set("Cache-Control", "no-store");
        res.set("X-Content-Type-Options", "nosniff");
        next();
    });

    app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
        if (!stripe || !stripeWebhookSecret) {
            return res.status(204).end();
        }

        let event;
        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                req.headers["stripe-signature"],
                stripeWebhookSecret
            );
        } catch (error) {
            logger.warn("payments.stripe_webhook_rejected", {
                requestId: req.requestId,
                error: error.message,
            });
            return res.status(400).send("Invalid webhook");
        }

        try {
            if (event.type === "payment_intent.succeeded") {
                const paymentIntent = event.data.object;
                const order = getOrderByProviderReference(db, "stripe", paymentIntent.id);

                if (!order && paymentIntent.metadata?.source === "recytech-shop") {
                    return res.status(503).send("Order is not ready");
                }

                if (order) {
                    markOrderPaid(db, order.id, {
                        stripePaymentIntentId: paymentIntent.id,
                        paymentStatus: paymentIntent.status,
                    });
                    logger.info(`[payments] Stripe webhook marked order ${orderLogId(order)} paid for intent ${paymentIntent.id}`);
                }
            }

            if (["payment_intent.payment_failed", "payment_intent.canceled"].includes(event.type)) {
                const paymentIntent = event.data.object;
                const order = getOrderByProviderReference(db, "stripe", paymentIntent.id);

                if (!order && paymentIntent.metadata?.source === "recytech-shop") {
                    return res.status(503).send("Order is not ready");
                }

                if (order) {
                    const nextStatus = stripeFailureOrderStatus(event.type);
                    updateOrderStatus(db, order.id, nextStatus, {
                        stripePaymentIntentId: paymentIntent.id,
                        paymentStatus: paymentIntent.status,
                    });
                    logger.info(`[payments] Stripe webhook marked order ${orderLogId(order)} ${nextStatus} for intent ${paymentIntent.id}`);
                }
            }

            return res.status(200).json({ received: true });
        } catch (error) {
            logger.error("payments.stripe_webhook_processing_failed", {
                requestId: req.requestId,
                eventId: event.id,
                eventType: event.type,
                error: error.message,
            });
            return res.status(500).send("Webhook processing failed");
        }
    });

    app.post("/webhooks/swiss-bitcoin-pay", express.raw({ type: "application/json" }), (req, res) => {
        if (!verifySwissBitcoinPayWebhook(req)) {
            return res.status(401).json({ error: "Invalid webhook secret" });
        }

        let invoice;
        try {
            invoice = JSON.parse(req.body.toString("utf8") || "{}");
        } catch (error) {
            logger.warn("payments.sbp_webhook_rejected", {
                requestId: req.requestId,
                error: error.message,
            });
            return res.status(400).send("Invalid webhook");
        }

        const invoiceId = normalizeText(invoice.id || invoice.invoice?.id);
        if (!invoiceId) {
            return res.status(400).send("Missing invoice id");
        }

        try {
            const resolved = findSwissBitcoinPayOrder({
                db,
                invoice,
                invoiceId,
                getOrderByProviderReference,
                getOrderByNumber,
                updateOrderProviderReference,
                normalizeText,
            });
            const { order } = resolved;

            if (resolved.recovered) {
                logger.warn(`[payments] Recovered Swiss Bitcoin Pay reference ${invoiceId} for order ${orderLogId(order)}`);
            }

            if (!order) {
                return res.status(503).send("Order is not ready");
            }

            const nextStatus = mapSwissBitcoinPayStatus(invoice);
            const metadata = {
                swissBitcoinPayInvoiceId: invoiceId,
                invoiceStatus: invoice.status || "",
                paymentMethod: invoice.paymentMethod || "",
                txId: invoice.txId || "",
            };

            if (nextStatus === "paid") {
                markOrderPaid(db, order.id, metadata);
                logger.info(`[payments] Swiss Bitcoin Pay webhook marked order ${orderLogId(order)} paid for invoice ${invoiceId}`);
            } else {
                updateOrderStatus(db, order.id, nextStatus, metadata);
                logger.info(`[payments] Swiss Bitcoin Pay webhook marked order ${orderLogId(order)} ${nextStatus} for invoice ${invoiceId}`);
            }

            return res.status(200).json({ received: true });
        } catch (error) {
            logger.error("payments.sbp_webhook_processing_failed", {
                requestId: req.requestId,
                invoiceId,
                error: error.message,
            });
            return res.status(500).send("Webhook processing failed");
        }
    });
}

module.exports = { findSwissBitcoinPayOrder, registerWebhookRoutes, stripeFailureOrderStatus };
