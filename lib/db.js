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
    listFeaturedProducts,
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
    createOrder,
    getOrderById,
    getOrderByNumber,
    getOrderByProviderReference,
    updateOrderProviderReference,
    updateOrderStatus: updateOrderStatusRecord,
    updateOrderRecord: updateOrderRecordRaw,
    listRecentOrders,
    listOrders,
    listStaleReservedExternalPaymentOrders,
    countOrders,
    deleteOrder,
} = require("./repositories/orders");

function nowIso() {
    return new Date().toISOString();
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
    return releaseOrderInventoryWithInventory(db, orderId, {
        metadata: options.metadata || null,
        status: options.status || null,
        createdAt: options.created_at || null,
        getOrderById,
        getProductById,
        nowIso,
    });
}

function updateOrderStatus(db, orderId, status, metadata = null) {
    if (shouldReleaseInventoryForStatus(status)) {
        return releaseOrderInventory(db, orderId, { status, metadata });
    }

    return updateOrderStatusRecord(db, orderId, status, metadata);
}

function updateOrderRecord(db, orderId, updates = {}) {
    if (updates.status && shouldReleaseInventoryForStatus(updates.status)) {
        return releaseOrderInventory(db, orderId, {
            status: updates.status,
            metadata: updates.metadata || null,
            created_at: updates.created_at || null,
        });
    }

    return updateOrderRecordRaw(db, orderId, updates);
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
    listFeaturedProducts,
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
    deleteOrder,
};
