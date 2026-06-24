const express = require("express");

function registerWebhookRoutes(deps) {
    const {
        app,
        db,
        providers,
        repositories,
        payments,
        text,
    } = deps;
    const { stripe, env } = providers;
    const { getOrderByProviderReference, markOrderPaid, updateOrderStatus } = repositories;
    const { verifySwissBitcoinPayWebhook, mapSwissBitcoinPayStatus } = payments;
    const { normalizeText } = text;

    app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
        if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
            return res.status(204).end();
        }

        try {
            const signature = req.headers["stripe-signature"];
            const event = stripe.webhooks.constructEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET);

            if (event.type === "payment_intent.succeeded") {
                const paymentIntent = event.data.object;
                const order = getOrderByProviderReference(db, "stripe", paymentIntent.id);

                if (order) {
                    markOrderPaid(db, order.id, {
                        stripePaymentIntentId: paymentIntent.id,
                        paymentStatus: paymentIntent.status,
                    });
                }
            }

            if (["payment_intent.payment_failed", "payment_intent.canceled"].includes(event.type)) {
                const paymentIntent = event.data.object;
                const order = getOrderByProviderReference(db, "stripe", paymentIntent.id);

                if (order) {
                    updateOrderStatus(db, order.id, "failed", {
                        stripePaymentIntentId: paymentIntent.id,
                        paymentStatus: paymentIntent.status,
                    });
                }
            }

            res.status(200).json({ received: true });
        } catch (error) {
            res.status(400).send(`Webhook Error: ${error.message}`);
        }
    });

    app.post("/webhooks/swiss-bitcoin-pay", express.raw({ type: "application/json" }), (req, res) => {
        try {
            if (!verifySwissBitcoinPayWebhook(req)) {
                return res.status(401).json({ error: "Invalid webhook secret" });
            }

            const invoice = JSON.parse(req.body.toString("utf8") || "{}");
            const invoiceId = normalizeText(invoice.id || invoice.invoice?.id);

            if (!invoiceId) {
                return res.status(200).json({ received: true });
            }

            const order = getOrderByProviderReference(db, "swissbitcoinpay", invoiceId);
            if (!order) {
                return res.status(200).json({ received: true });
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
            } else {
                updateOrderStatus(db, order.id, nextStatus, metadata);
            }

            res.status(200).json({ received: true });
        } catch (error) {
            res.status(400).send(`Webhook Error: ${error.message}`);
        }
    });
}

module.exports = { registerWebhookRoutes };
