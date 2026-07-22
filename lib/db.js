const {
    DEFAULT_SETTINGS,
    initializeDatabase,
} = require("./db/schema");
const {
    markOrderPaid: markOrderPaidWithInventory,
    releaseOrderInventory: releaseOrderInventoryWithInventory,
    reserveOrderInventory: reserveOrderInventoryWithInventory,
    shouldReleaseInventoryForStatus,
} = require("./order-service");
const {
    createProduct,
    updateProduct,
    deleteProduct,
    listPacksContainingProduct,
    listPublishedProducts,
    listAdminProducts,
    listAdminProductRows,
    listProductCategories,
    listAdminCategories,
    deleteProductCategory,
    getProductBySlug,
    getProductById,
} = require("./repositories/products");
const {
    getSettings,
    saveSettings,
} = require("./repositories/settings");
const {
    getAdminByUsername,
    getAdminById,
    listAdmins,
    countAdminsByRole,
    createAdmin,
    updateAdmin,
    deleteAdmin,
} = require("./repositories/admins");
const {
    listApprovedSiteReviews,
    getSiteReviewSummary,
    listPendingSiteReviews,
    countPendingSiteReviews,
    createSiteReview,
    approveSiteReview,
    deleteSiteReview,
} = require("./repositories/site-reviews");
const {
    listPromoCodes,
    getPromoCodeById,
    getPromoCodeByCode,
    createPromoCode,
    updatePromoCode,
    deletePromoCode,
} = require("./repositories/promo-codes");
const { getDashboardStats } = require("./repositories/dashboard");
const {
    createOrder: createOrderRecord,
    getOrderById,
    getOrderByNumber,
    getOrderByProviderReference,
    getOrderByIdempotencyKey,
    updateOrderProviderReference,
    updateOrderStatus: updateOrderStatusRecord,
    updateOrderRecord: updateOrderRecordRaw,
    listRecentOrders,
    listOrders,
    listStaleReservedExternalPaymentOrders,
    countOrders,
    deleteOrder: deleteOrderRecord,
} = require("./repositories/orders");
const {
    assertAdminOrderStatusTransition,
    hasRecordedPayment,
    isInventoryHoldingOrderStatus,
    isPaidOrderStatus,
} = require("./order-statuses");

function nowIso() {
    return new Date().toISOString();
}

function hasActivePromoReservation(metadata = {}) {
    return Boolean(
        metadata.promo_redemption_reserved_at
        && !metadata.promo_redemption_released_at
        && !metadata.promo_redemption_redeemed_at
    );
}

function createOrder(db, input) {
    const promoCodeId = Number.parseInt(input.metadata?.promo?.id, 10);
    if (!Number.isInteger(promoCodeId) || promoCodeId <= 0) {
        return createOrderRecord(db, input);
    }

    return db.transaction(() => {
        const timestamp = nowIso();
        const reservation = db.prepare(`
            UPDATE promo_codes
            SET times_redeemed = times_redeemed + 1,
                updated_at = ?
            WHERE id = ?
              AND active = 1
              AND (max_redemptions IS NULL OR times_redeemed < max_redemptions)
        `).run(timestamp, promoCodeId);

        if (!reservation.changes) {
            throw new Error("Ce code promo n'est plus disponible.");
        }

        return createOrderRecord(db, {
            ...input,
            metadata: {
                ...(input.metadata || {}),
                promo_redemption_reserved_at: timestamp,
            },
        });
    }).immediate();
}

function releasePromoReservation(db, order, timestamp = nowIso()) {
    if (!order || !hasActivePromoReservation(order.metadata) || order.metadata?.payment_recorded_at) {
        return order?.metadata || {};
    }

    const promoCodeId = Number.parseInt(order.metadata?.promo?.id, 10);
    if (Number.isInteger(promoCodeId) && promoCodeId > 0) {
        db.prepare(`
            UPDATE promo_codes
            SET times_redeemed = MAX(times_redeemed - 1, 0),
                updated_at = ?
            WHERE id = ?
        `).run(timestamp, promoCodeId);
    }

    return {
        ...order.metadata,
        promo_redemption_released_at: timestamp,
    };
}

function markOrderPaid(db, orderId, metadata = null) {
    return markOrderPaidWithInventory(db, orderId, {
        metadata,
        getOrderById,
        getProductById,
        nowIso,
    });
}

function reserveOrderInventory(db, orderId, metadata = null) {
    return reserveOrderInventoryWithInventory(db, orderId, {
        metadata,
        getOrderById,
        getProductById,
        nowIso,
    });
}

function releaseOrderInventory(db, orderId, options = {}) {
    return db.transaction(() => {
        const order = getOrderById(db, orderId);
        if (!order) {
            return null;
        }

        const metadata = releasePromoReservation(db, order);
        return releaseOrderInventoryWithInventory(db, orderId, {
            metadata: options.metadata ? { ...metadata, ...options.metadata } : metadata,
            status: options.status || null,
            createdAt: options.created_at || null,
            getOrderById,
            getProductById,
            nowIso,
        });
    }).immediate();
}

function updateOrderStatus(db, orderId, status, metadata = null) {
    return db.transaction(() => {
        const current = getOrderById(db, orderId);
        if (!current) {
            return null;
        }

        if (hasRecordedPayment(current)) {
            return updateOrderStatusRecord(db, orderId, current.status, metadata);
        }

        if (["failed", "cancelled"].includes(current.status) && isInventoryHoldingOrderStatus(status)) {
            return updateOrderStatusRecord(db, orderId, current.status, metadata);
        }

        if (shouldReleaseInventoryForStatus(status)) {
            return releaseOrderInventory(db, orderId, { status, metadata });
        }

        return updateOrderStatusRecord(db, orderId, status, metadata);
    }).immediate();
}

function canDeleteOrder(order) {
    if (!order) {
        return false;
    }

    const hasExternalPaymentReference = ["stripe", "swissbitcoinpay"].includes(order.provider)
        || Boolean(order.provider_reference);
    const hasInventoryHistory = Boolean(
        order.metadata?.inventory_reserved_at
        || order.metadata?.inventory_released_at
    );

    return !hasExternalPaymentReference
        && !hasInventoryHistory
        && !order.metadata?.payment_recorded_at
        && !isPaidOrderStatus(order.status)
        && order.status !== "refunded";
}

function deleteOrder(db, orderId) {
    return db.transaction(() => {
        const order = getOrderById(db, orderId);
        if (!canDeleteOrder(order)) {
            throw new Error("Cette commande doit être conservée car elle possède un historique de paiement ou de stock.");
        }

        releasePromoReservation(db, order);
        return deleteOrderRecord(db, orderId);
    }).immediate();
}

function updateOrderRecord(db, orderId, updates = {}) {
    return db.transaction(() => {
        const current = getOrderById(db, orderId);
        if (!current) {
            return null;
        }

        if (updates.status) {
            assertAdminOrderStatusTransition(current, updates.status);
        }

        if (updates.status && shouldReleaseInventoryForStatus(updates.status)) {
            return releaseOrderInventory(db, orderId, {
                status: updates.status,
                metadata: updates.metadata || null,
                created_at: updates.created_at || null,
            });
        }

        return updateOrderRecordRaw(db, orderId, updates);
    }).immediate();
}

module.exports = {
    DEFAULT_SETTINGS,
    initializeDatabase,
    getSettings,
    saveSettings,
    createProduct,
    updateProduct,
    deleteProduct,
    listPacksContainingProduct,
    listPublishedProducts,
    listAdminProducts,
    listAdminProductRows,
    listProductCategories,
    listAdminCategories,
    deleteProductCategory,
    getProductBySlug,
    getProductById,
    getAdminByUsername,
    getAdminById,
    listAdmins,
    countAdminsByRole,
    createAdmin,
    updateAdmin,
    deleteAdmin,
    listApprovedSiteReviews,
    getSiteReviewSummary,
    listPendingSiteReviews,
    countPendingSiteReviews,
    createSiteReview,
    approveSiteReview,
    deleteSiteReview,
    listPromoCodes,
    getPromoCodeById,
    getPromoCodeByCode,
    createPromoCode,
    updatePromoCode,
    deletePromoCode,
    getDashboardStats,
    createOrder,
    getOrderById,
    getOrderByNumber,
    getOrderByProviderReference,
    getOrderByIdempotencyKey,
    updateOrderProviderReference,
    updateOrderStatus,
    updateOrderRecord,
    reserveOrderInventory,
    releaseOrderInventory,
    markOrderPaid,
    listRecentOrders,
    listOrders,
    listStaleReservedExternalPaymentOrders,
    countOrders,
    canDeleteOrder,
    deleteOrder,
};
