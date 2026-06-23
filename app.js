const express = require("express");
const Stripe = require("stripe");
const {
    registerWebhookEndpoints,
    registerPageRoutes,
    registerFallbackRoutes,
} = require("./lib/app-routes");
const { createCartSessionHelpers } = require("./lib/cart-session");
const { createCheckoutStateHelpers } = require("./lib/checkout-state");
const { createAppConfig } = require("./lib/config");
const { createMailService } = require("./lib/mail-service");
const { createProductOptionReader } = require("./lib/product-option-reader");
const { createPublicProductPresenters } = require("./lib/public-product-presenters");
const { createRepositoryContexts } = require("./lib/repository-contexts");
const { createSettingsCache } = require("./lib/settings-cache");
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
const { registerAppMiddleware } = require("./lib/http/app-middleware");
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
const database = require("./lib/db");

const config = createAppConfig({
    env: process.env,
    rootDir: __dirname,
});
const { env } = config;
const { baseUrl, getOrderDocumentConfig, absoluteUrl } = createUrlHelpers(env);
const app = express();
const db = database.initializeDatabase(config.paths.database, env);
const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;
const stripePublishableKey = config.stripe.publishableKey;
const {
    getCachedSettings,
    saveCachedSettings,
} = createSettingsCache({
    db,
    getSettings: database.getSettings,
    saveSettings: database.saveSettings,
});
const repositoryContexts = createRepositoryContexts({
    database,
    settings: {
        getSettings: getCachedSettings,
        saveSettings: saveCachedSettings,
    },
    orderHelpers: {
        getOrderPaymentData,
        getOrderContactSnapshot,
        getOrderAdminData,
        buildOrderMailto,
        canEditOrderReceivedAmount,
        readReceivedPaymentInput,
    },
});
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
    getAdminById: repositoryContexts.admins.getAdminById,
    setFlash,
    saveSessionAndRedirect,
});

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
    getProductById: repositoryContexts.products.getProductById,
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
    getPromoCodeByCode: (code) => repositoryContexts.promos.getPromoCodeByCode(db, code),
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

const { readSelectedProductOptions } = createProductOptionReader({
    normalizeText,
    getProductUnitPriceCents,
});

function validateCheckout(req) {
    return validateCheckoutInput(req.body);
}

const providers = { env, stripe };
const http = {
    render,
    getViewHelpers,
    setFlash,
    saveSessionAndRedirect,
    getSafeRedirectTarget,
    requireAdmin,
    requireSuperadmin,
    getLoginRateLimitState,
    registerLoginFailure,
    clearLoginFailures,
    getOrCreateCsrfToken,
};
const text = {
    normalizeText,
    normalizeSingleLineText,
};
const money = {
    parseMoneyToCents,
    parseOptionalMoneyToCents,
    normalizeOrderDateTimeField,
};
const urls = {
    baseUrl,
    getOrderDocumentConfig,
};
const publicProducts = {
    setPublicApiHeaders,
    productCategoryList,
    serializePublicProduct,
    productMetaDescription,
    productStructuredData,
    organizationStructuredData,
};
const cart = {
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
};
const checkout = {
    normalizePromoCode,
    getPromoCodeOutcome,
    requirePromoCodeOutcome,
    getCheckoutPricing,
    getCheckoutForm,
    buildCheckoutDraft,
    setCheckoutForm,
    clearCheckoutForm,
    clearStripeDraft,
    validateCheckoutInput,
    getPromoCodeLabel,
};
const forms = {
    readAdminUserInput,
    readAdminAccountInput,
    readSiteReviewInput,
    readPromoCodeInput,
    readSelectedProductOptions,
    validateCheckout,
};
const uploads = {
    settingsUploadUrl,
    withProductUploads,
    withSettingsUpload,
    productInputWithUploads,
    buildProductFormState,
};
const mail = {
    getMailConfigError,
    isMailConfigured,
    buildOrderEmailDraft,
    sendStoreEmail,
    sendNewOrderNotification,
    notifyNewOrder,
};
const payments = {
    paymentState,
    createOrReuseStripeIntent,
    createOrderViewToken,
    verifyOrderViewToken,
    createSwissBitcoinPayInvoice,
    fetchSwissBitcoinPayInvoice,
    verifySwissBitcoinPayWebhook,
    mapSwissBitcoinPayStatus,
};
registerWebhookEndpoints({
    app,
    db,
    providers,
    repositories: repositoryContexts.orders,
    payments,
    text,
});

registerAppMiddleware({
    app,
    db,
    config,
    getOrCreateCsrfToken,
    getAdminById: repositoryContexts.admins.getAdminById,
    getViewHelpers,
    getCachedSettings,
    getFlash,
    buildCart,
    paymentState,
    baseUrl,
    absoluteUrl,
    isProductUploadRequest,
    withProductUploads,
    isSettingsUploadRequest,
    withSettingsUpload,
    isValidCsrfToken,
    setFlash,
    saveSessionAndRedirect,
});

registerPageRoutes({
    app,
    db,
    providers,
    http,
    text,
    money,
    forms,
    formatters: { SHIPPING_OPTIONS },
    urls,
    publicProducts,
    cart,
    checkout,
    uploads,
    mail,
    payments,
    settings: repositoryContexts.settings,
    products: repositoryContexts.products,
    admins: repositoryContexts.admins,
    reviews: repositoryContexts.reviews,
    promos: repositoryContexts.promos,
    dashboard: repositoryContexts.dashboard,
    orders: repositoryContexts.orders,
});

registerFallbackRoutes({
    app,
    setFlash,
    saveSessionAndRedirect,
});

module.exports = { app };
