const express = require("express");
const session = require("express-session");
const Stripe = require("stripe");
const { SqliteSessionStore, SESSION_TTL_MS } = require("./lib/sqlite-session-store");
const { registerAdminRoutes } = require("./routes/admin");
const { registerCheckoutRoutes } = require("./routes/checkout");
const { registerPublicApiRoutes } = require("./routes/public-api");
const { registerStorefrontRoutes } = require("./routes/storefront");
const { registerWebhookRoutes } = require("./routes/webhooks");
const { createCartSessionHelpers } = require("./lib/cart-session");
const { createCheckoutStateHelpers } = require("./lib/checkout-state");
const { createAppConfig } = require("./lib/config");
const { createMailService } = require("./lib/mail-service");
const { createPublicProductPresenters } = require("./lib/public-product-presenters");
const { createUploadHandlers } = require("./lib/upload-handlers");
const { createUrlHelpers } = require("./lib/url-helpers");
const { createFormReaders } = require("./lib/form-readers");
const {
    normalizeText,
    normalizeSingleLineText,
    toBoolean,
    parseInteger,
    parseMoneyToCents,
    parseOptionalMoneyToCents,
    normalizeOrderDateTimeField,
    formatDateTimeInputValue,
} = require("./lib/input-utils");
const {
    getOrderPaymentData,
    getOrderReceivedAmountCents,
    getOrderReceivedDeltaCents,
    canEditOrderReceivedAmount,
    readReceivedPaymentInput,
    getOrderContactSnapshot,
    buildOrderMailto,
    getOrderAdminData,
} = require("./lib/order-admin-helpers");
const {
    setFlash,
    getFlash,
    saveSessionAndRedirect,
    getSafeRedirectTarget,
} = require("./lib/http/session-utils");
const { getOrCreateCsrfToken, isValidCsrfToken } = require("./lib/http/csrf");
const { createAttemptRateLimiter, getRequestIp, startRateLimitPruning } = require("./lib/http/rate-limiter");
const { createAdminAuth } = require("./lib/http/admin-auth");
const { createOrderViewTokenHelpers } = require("./lib/payments/order-view-token");
const { createStripeIntentService } = require("./lib/payments/stripe-intents");
const {
    WEBHOOK_SECRET_HEADER,
    mapSwissBitcoinPayStatus,
    createSwissBitcoinPayService,
} = require("./lib/payments/swiss-bitcoin-pay");
const {
    SHIPPING_OPTIONS,
    PAYMENT_DISCOUNT_RATE,
    formatMoney,
    formatProductPrice,
    getOrderStatusLabel,
    getOrderStatusTone,
    getAdminRoleLabel,
    getOrderProviderLabel,
    formatDateTime,
} = require("./lib/shop-formatters");
const {
    initializeDatabase,
    getSettings,
    saveSettings,
    createProduct,
    updateProduct,
    deleteProduct,
    listPacksContainingProduct,
    listPublishedProducts,
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
    createAdmin: createAdminUser,
    updateAdmin: updateAdminUser,
    deleteAdmin: deleteAdminUser,
    listApprovedSiteReviews,
    getSiteReviewSummary,
    listPendingSiteReviews,
    createSiteReview,
    approveSiteReview,
    deleteSiteReview,
    listPromoCodes,
    getPromoCodeById,
    getPromoCodeByCode,
    createPromoCode: createPromoCodeRecord,
    updatePromoCode: updatePromoCodeRecord,
    deletePromoCode: deletePromoCodeRecord,
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
} = require("./lib/db");

const config = createAppConfig({
    env: process.env,
    rootDir: __dirname,
});
const { env } = config;
const { baseUrl, getOrderDocumentConfig, absoluteUrl } = createUrlHelpers(env);
const app = express();
const db = initializeDatabase(config.paths.database, env);
let settingsCache = null;
const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;
const stripePublishableKey = config.stripe.publishableKey;
const {
    createOrderViewToken,
    verifyOrderViewToken,
} = createOrderViewTokenHelpers(config.orderViews.tokenSecret);
const swissBitcoinPay = createSwissBitcoinPayService({
    apiUrl: config.swissBitcoinPay.apiUrl,
    apiKey: config.swissBitcoinPay.apiKey,
    webhookSecret: config.swissBitcoinPay.webhookSecret,
    webhookSecretHeader: WEBHOOK_SECRET_HEADER,
    baseUrl,
    createOrderViewToken,
});
const createSwissBitcoinPayInvoice = swissBitcoinPay.createInvoice;
const fetchSwissBitcoinPayInvoice = swissBitcoinPay.fetchInvoice;
const verifySwissBitcoinPayWebhook = swissBitcoinPay.verifyWebhook;

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const STRIPE_INTENT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const STRIPE_INTENT_RATE_LIMIT_BLOCK_MS = 10 * 60 * 1000;
const STRIPE_INTENT_RATE_LIMIT_MAX_ATTEMPTS = 20;
const RATE_LIMIT_MAX_KEYS = 1000;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

const loginRateLimiter = createAttemptRateLimiter({
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
    blockMs: LOGIN_RATE_LIMIT_BLOCK_MS,
    maxAttempts: LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
    maxKeys: RATE_LIMIT_MAX_KEYS,
});
const stripeIntentRateLimiter = createAttemptRateLimiter({
    windowMs: STRIPE_INTENT_RATE_LIMIT_WINDOW_MS,
    blockMs: STRIPE_INTENT_RATE_LIMIT_BLOCK_MS,
    maxAttempts: STRIPE_INTENT_RATE_LIMIT_MAX_ATTEMPTS,
    maxKeys: RATE_LIMIT_MAX_KEYS,
    getKey: (req) => `${getRequestIp(req)}:${normalizeText(req.sessionID) || "anonymous"}`,
});
startRateLimitPruning([loginRateLimiter, stripeIntentRateLimiter], RATE_LIMIT_PRUNE_INTERVAL_MS);
const getLoginRateLimitState = (req) => loginRateLimiter.getState(req);
const registerLoginFailure = (req) => loginRateLimiter.registerAttempt(req);
const clearLoginFailures = (req) => loginRateLimiter.clear(req);
const getStripeIntentRateLimitState = (req) => stripeIntentRateLimiter.getState(req);
const registerStripeIntentAttempt = (req) => stripeIntentRateLimiter.registerAttempt(req);
const {
    requireAdmin,
    requireSuperadmin,
} = createAdminAuth({
    db,
    getAdminById,
    setFlash,
    saveSessionAndRedirect,
});

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", config.paths.viewsDir);
app.use("/static/uploads", express.static(config.paths.uploadsDir, {
    maxAge: "5m",
}));
app.use("/static", express.static(config.paths.publicDir, {
    maxAge: "1h",
}));

const {
    settingsUploadUrl,
    withProductUploads,
    withSettingsUpload,
    isProductUploadRequest,
    isSettingsUploadRequest,
    productInputWithUploads,
    buildProductFormState,
} = createUploadHandlers({
    productUploadDir: config.paths.productUploads,
    settingsUploadDir: config.paths.settingsUploads,
    setFlash,
    saveSessionAndRedirect,
});
const {
    setPublicApiHeaders,
    productCategoryList,
    serializePublicProduct,
    productMetaDescription,
    productStructuredData,
    organizationStructuredData,
} = createPublicProductPresenters({
    baseUrl,
    absoluteUrl,
    formatProductPrice,
});
const {
    getCartItems,
    setCartItems,
    getConfigurationAvailableQuantity,
    ensureAvailableProductQuantity,
    validateRequestedServiceTags,
    getProductUnitPriceCents,
    snapshotPackBundleItems,
    buildCart,
    makeCartItemKey,
    upsertCartItem,
    removeCartItem,
} = createCartSessionHelpers({
    db,
    getProductById,
    normalizeText,
    normalizeSingleLineText,
    productCategoryList,
});
const {
    normalizePromoCode,
    formatPromoCodeDiscount,
    getPromoCodeStatus,
    getPromoCodeStatusTone,
    getPromoCodeOutcome,
    requirePromoCodeOutcome,
    getCheckoutPricing,
    getCheckoutForm,
    buildCheckoutDraft,
    setCheckoutForm,
    clearCheckoutForm,
    getStripeDraft,
    setStripeDraft,
    clearStripeDraft,
    validateCheckoutInput,
    getPromoCodeLabel,
} = createCheckoutStateHelpers({
    SHIPPING_OPTIONS,
    PAYMENT_DISCOUNT_RATE,
    formatMoney,
    getPromoCodeByCode: (code) => getPromoCodeByCode(db, code),
    normalizeText,
    paymentState,
});
const {
    readAdminUserInput,
    readAdminAccountInput,
    readSiteReviewInput,
    readPromoCodeInput,
} = createFormReaders({ normalizePromoCode });
const { createOrReuseStripeIntent } = createStripeIntentService({
    stripe,
    paymentState,
    buildCart,
    buildCheckoutDraft,
    getCheckoutForm,
    shippingOptions: SHIPPING_OPTIONS,
    requirePromoCodeOutcome,
    getCheckoutPricing,
    getStripeDraft,
    setStripeDraft,
    getRateLimitState: getStripeIntentRateLimitState,
    registerAttempt: registerStripeIntentAttempt,
});

function getCachedSettings() {
    if (!settingsCache) {
        settingsCache = getSettings(db);
    }

    return settingsCache;
}

function saveCachedSettings(_db, values) {
    saveSettings(db, values);
    settingsCache = null;
}

const {
    getMailConfigError,
    isMailConfigured,
    buildOrderEmailDraft,
    sendStoreEmail,
    sendNewOrderNotification,
} = createMailService({
    env,
    getSettings: getCachedSettings,
    normalizeText,
    parseInteger,
    toBoolean,
    formatMoney,
    formatDateTime,
    getOrderContactSnapshot,
    getOrderProviderLabel,
    getOrderStatusLabel,
});

function paymentState() {
    return {
        stripeEnabled: Boolean(stripe && stripePublishableKey),
        stripePublishableKey,
        bitcoinEnabled: Boolean(swissBitcoinPay.apiKey && swissBitcoinPay.webhookSecret),
        transferEnabled: true,
    };
}

function getViewHelpers() {
    return {
        formatMoney,
        formatProductPrice,
        formatDateTime,
        formatDateTimeInputValue,
        formatPromoCodeDiscount,
        getOrderStatusLabel,
        getOrderStatusTone,
        getOrderProviderLabel,
        getAdminRoleLabel,
        getPromoCodeStatus,
        getPromoCodeStatusTone,
        getOrderReceivedAmountCents,
        getOrderReceivedDeltaCents,
        canEditOrderReceivedAmount,
    };
}

function render(res, view, options = {}) {
    const request = res.req;
    res.render(view, {
        ...getViewHelpers(),
        structuredData: options.structuredData ?? (request ? organizationStructuredData(request) : null),
        ...options,
    });
}

async function notifyNewOrder(order) {
    try {
        await sendNewOrderNotification(order);
    } catch (error) {
        console.error(`Order notification email failed for ${order.order_number}: ${error.message}`);
    }
}

function readSelectedProductOptions(product, body, fieldNameForIndex = (index) => `selected_option_${index}`) {
    const groups = Array.isArray(product.option_groups) ? product.option_groups : [];

    const selectedOptions = groups.map((group, index) => {
        const value = normalizeText(body[fieldNameForIndex(index, group)]);
        if (!group.values.includes(value)) {
            throw new Error(`Veuillez choisir une option valide pour « ${group.name} ».`);
        }

        return {
            name: group.name,
            value,
        };
    });

    getProductUnitPriceCents(product, selectedOptions);

    return selectedOptions;
}

function validateCheckout(req) {
    return validateCheckoutInput(req.body);
}

registerWebhookRoutes({
    app,
    stripe,
    env,
    db,
    getOrderByProviderReference,
    markOrderPaid,
    updateOrderStatus,
    verifySwissBitcoinPayWebhook,
    normalizeText,
    mapSwissBitcoinPayStatus,
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(
    session({
        store: new SqliteSessionStore(db),
        secret: config.session.secret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: "auto",
            sameSite: "lax",
            maxAge: SESSION_TTL_MS,
        },
    })
);

app.use((req, res, next) => {
    const requestIsSecure = req.secure || req.get("x-forwarded-proto") === "https";
    res.set("X-Frame-Options", "DENY");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (requestIsSecure) {
        res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }

    res.locals.csrfToken = getOrCreateCsrfToken(req);
    const currentAdmin = req.session.adminId ? getAdminById(db, req.session.adminId) : null;
    const hideFooter = req.path === "/cart" || req.path.startsWith("/admin");

    Object.assign(res.locals, getViewHelpers());
    res.locals.currentPath = req.path;
    res.locals.settings = getCachedSettings();
    res.locals.flash = getFlash(req);
    res.locals.cart = buildCart(req);
    res.locals.currentAdmin = currentAdmin;
    res.locals.paymentConfig = paymentState();
    res.locals.showFooter = !hideFooter;
    res.locals.canonicalUrl = `${baseUrl(req).replace(/\/$/, "")}${req.path}`;
    res.locals.absoluteUrl = (value) => absoluteUrl(req, value);
    req.currentAdmin = currentAdmin;
    next();
});

app.use((req, res, next) => {
    if (!req.currentAdmin) {
        return next();
    }

    if (isProductUploadRequest(req)) {
        return withProductUploads(req, res, next);
    }

    if (isSettingsUploadRequest(req)) {
        return withSettingsUpload(req, res, next);
    }

    return next();
});

app.use((req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || req.path.startsWith("/webhooks/")) {
        return next();
    }

    if (isValidCsrfToken(req)) {
        return next();
    }

    setFlash(req, "error", "Votre session de sécurité a expiré. Veuillez réessayer.");
    return saveSessionAndRedirect(req, res, req.get("referer") || "/");
});

registerPublicApiRoutes({
    app,
    db,
    stripe,
    setPublicApiHeaders,
    listPublishedProducts,
    serializePublicProduct,
    setCheckoutForm,
    buildCheckoutDraft,
    getCheckoutForm,
    buildCart,
    setFlash,
    saveSessionAndRedirect,
    clearStripeDraft,
    getPromoCodeOutcome,
    createOrReuseStripeIntent,
    paymentState,
    normalizeText,
    validateCheckoutInput,
    requirePromoCodeOutcome,
    getCheckoutPricing,
    getOrderByProviderReference,
    createOrder,
    notifyNewOrder,
    createOrderViewToken,
});

registerStorefrontRoutes({
    app,
    db,
    render,
    setFlash,
    saveSessionAndRedirect,
    getSafeRedirectTarget,
    normalizeText,
    parseMoneyToCents,
    readSiteReviewInput,
    readSelectedProductOptions,
    ensureAvailableProductQuantity,
    upsertCartItem,
    getCartItems,
    makeCartItemKey,
    removeCartItem,
    productMetaDescription,
    productStructuredData,
    organizationStructuredData,
    listPublishedProducts,
    listProductCategories,
    listApprovedSiteReviews,
    getSiteReviewSummary,
    createSiteReview,
    getProductBySlug,
    getProductById,
});

registerCheckoutRoutes({
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
});

registerAdminRoutes({
    app,
    db,
    requireAdmin,
    requireSuperadmin,
    render,
    getViewHelpers,
    setFlash,
    saveSessionAndRedirect,
    normalizeText,
    normalizeSingleLineText,
    parseMoneyToCents,
    parseOptionalMoneyToCents,
    normalizeOrderDateTimeField,
    normalizePromoCode,
    readAdminUserInput,
    readAdminAccountInput,
    readPromoCodeInput,
    getLoginRateLimitState,
    registerLoginFailure,
    clearLoginFailures,
    getOrCreateCsrfToken,
    readSelectedProductOptions,
    ensureAvailableProductQuantity,
    validateRequestedServiceTags,
    getProductUnitPriceCents,
    getConfigurationAvailableQuantity,
    productCategoryList,
    snapshotPackBundleItems,
    getPromoCodeOutcome,
    getPromoCodeLabel,
    getOrderContactSnapshot,
    getOrderAdminData,
    buildOrderMailto,
    buildOrderEmailDraft,
    isMailConfigured,
    getMailConfigError,
    sendStoreEmail,
    canEditOrderReceivedAmount,
    readReceivedPaymentInput,
    getOrderPaymentData,
    settingsUploadUrl,
    withProductUploads,
    withSettingsUpload,
    productInputWithUploads,
    buildProductFormState,
    baseUrl,
    getOrderDocumentConfig,
    getSettings: getCachedSettings,
    saveSettings: saveCachedSettings,
    createProduct,
    updateProduct,
    deleteProduct,
    listPacksContainingProduct,
    listAdminProducts,
    listProductCategories,
    listAdminCategories,
    deleteProductCategory,
    getProductById,
    getAdminByUsername,
    getAdminById,
    listAdmins,
    countAdminsByRole,
    createAdminUser,
    updateAdminUser,
    deleteAdminUser,
    listPendingSiteReviews,
    approveSiteReview,
    deleteSiteReview,
    listPromoCodes,
    getPromoCodeById,
    createPromoCodeRecord,
    updatePromoCodeRecord,
    deletePromoCodeRecord,
    getDashboardStats,
    createOrder,
    getOrderById,
    updateOrderRecord,
    markOrderPaid,
    listRecentOrders,
    listOrders,
    deleteOrder,
});

app.use((error, req, res, _next) => {
    console.error(error);

    if (req.currentAdmin) {
        setFlash(req, "error", `Erreur serveur : ${error.message}`);
        return saveSessionAndRedirect(req, res, req.get("referer") || "/admin");
    }

    return res.status(500).send("Internal Server Error");
});

app.use((req, res) => {
    res.status(404).render("not-found", { title: "Page introuvable" });
});

module.exports = { app };
