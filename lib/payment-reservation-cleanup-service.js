const logger = require("./logger");

const STRIPE_CANCELABLE_STALE_STATUSES = new Set([
    "requires_payment_method",
    "requires_confirmation",
    "requires_action",
]);

function defaultNow() {
    return Date.now();
}

function staleCutoffIso(nowMs, ttlMs) {
    return new Date(nowMs - ttlMs).toISOString();
}

function reservationMetadata(order, timestamp, extra = {}) {
    return {
        reservation_cleanup_at: timestamp,
        reservation_cleanup_reason: "stale_external_payment",
        ...extra,
        previous_status: order.status,
    };
}

function stripeIntentId(order) {
    return String(order.provider_reference || order.metadata?.stripePaymentIntentId || "").trim();
}

function swissBitcoinPayInvoiceId(order) {
    return String(order.provider_reference || order.metadata?.swissBitcoinPayInvoiceId || "").trim();
}

function createPaymentReservationCleanupService({
    db,
    orders,
    stripe = null,
    swissBitcoinPay = null,
    mapSwissBitcoinPayStatus,
    ttlMs,
    limit,
    now = defaultNow,
}) {
    function cleanupTimestamp() {
        return new Date(now()).toISOString();
    }

    async function failAndRelease(order, metadata) {
        await orders.updateOrderStatus(db, order.id, "failed", reservationMetadata(order, cleanupTimestamp(), metadata));
        return "released";
    }

    async function reconcileStripeReservation(order) {
        if (!stripe?.paymentIntents) {
            return "skipped";
        }

        const paymentIntentId = stripeIntentId(order);
        if (!paymentIntentId) {
            throw new Error(`Stripe reference missing for reserved order ${order.order_number}`);
        }

        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        const paymentStatus = String(paymentIntent?.status || "").toLowerCase();

        if (paymentStatus === "succeeded") {
            await orders.markOrderPaid(db, order.id, reservationMetadata(order, cleanupTimestamp(), {
                stripePaymentIntentId: paymentIntentId,
                paymentStatus,
            }));
            return "paid";
        }

        if (paymentStatus === "canceled") {
            return failAndRelease(order, {
                stripePaymentIntentId: paymentIntentId,
                paymentStatus,
            });
        }

        if (STRIPE_CANCELABLE_STALE_STATUSES.has(paymentStatus)) {
            const canceledIntent = await stripe.paymentIntents.cancel(paymentIntentId, {
                cancellation_reason: "abandoned",
            });
            const canceledStatus = String(canceledIntent?.status || "").toLowerCase();

            if (canceledStatus === "canceled") {
                return failAndRelease(order, {
                    stripePaymentIntentId: paymentIntentId,
                    paymentStatus: canceledStatus,
                });
            }
        }

        return "kept";
    }

    async function reconcileSwissBitcoinPayReservation(order) {
        if (!swissBitcoinPay?.fetchInvoice || !mapSwissBitcoinPayStatus) {
            return "skipped";
        }

        const invoiceId = swissBitcoinPayInvoiceId(order);
        if (!invoiceId) {
            throw new Error(`Swiss Bitcoin Pay reference missing for reserved order ${order.order_number}`);
        }

        const invoice = await swissBitcoinPay.fetchInvoice(invoiceId);
        const nextStatus = mapSwissBitcoinPayStatus(invoice);
        const metadata = {
            swissBitcoinPayInvoiceId: invoice.id || invoiceId,
            invoiceStatus: invoice.status || "",
            paymentMethod: invoice.paymentMethod || "",
            txId: invoice.txId || "",
        };

        if (nextStatus === "paid") {
            await orders.markOrderPaid(db, order.id, reservationMetadata(order, cleanupTimestamp(), metadata));
            return "paid";
        }

        if (nextStatus === "failed") {
            return failAndRelease(order, metadata);
        }

        return "kept";
    }

    async function reconcileOrder(order) {
        if (order.provider === "stripe") {
            return reconcileStripeReservation(order);
        }

        if (order.provider === "swissbitcoinpay") {
            return reconcileSwissBitcoinPayReservation(order);
        }

        return "skipped";
    }

    async function cleanupStaleReservations() {
        const cutoffIso = staleCutoffIso(now(), ttlMs);
        const staleOrders = orders.listStaleReservedExternalPaymentOrders(db, {
            cutoffIso,
            limit,
        });
        const summary = {
            checked: staleOrders.length,
            paid: 0,
            released: 0,
            kept: 0,
            skipped: 0,
            failed: 0,
        };

        for (const order of staleOrders) {
            try {
                const outcome = await reconcileOrder(order);
                if (Object.prototype.hasOwnProperty.call(summary, outcome)) {
                    summary[outcome] += 1;
                }
            } catch (error) {
                summary.failed += 1;
                logger.error(`[payments] Stale reservation cleanup failed for ${order.order_number}: ${error.message}`);
            }
        }

        if (summary.checked && (summary.paid || summary.released || summary.failed)) {
            logger.info("payments.reservation_cleanup", summary);
        }

        return summary;
    }

    return {
        cleanupStaleReservations,
        reconcileOrder,
    };
}

module.exports = {
    createPaymentReservationCleanupService,
    staleCutoffIso,
};
