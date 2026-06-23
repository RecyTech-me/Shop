const {
    DEFAULT_SETTINGS,
    initializeDatabase,
} = require("./db/schema");
const { markOrderPaid: markOrderPaidWithInventory } = require("./order-service");
const {
    createProduct,
    updateProduct,
    deleteProduct,
    listPacksContainingProduct,
    listPublishedProducts,
    listFeaturedProducts,
    listAdminProducts,
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
    updateOrderStatus,
    updateOrderRecord,
    listRecentOrders,
    listOrders,
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
    markOrderPaid,
    listRecentOrders,
    listOrders,
    deleteOrder,
};
