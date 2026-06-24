const Stripe = require("stripe");
const { createCartSessionHelpers } = require("./cart-session");
const { createCheckoutStateHelpers } = require("./checkout-state");
const { createCheckoutOrderService } = require("./checkout-order-service");
const { createAppConfig } = require("./config");
const { createMailService } = require("./mail-service");
const logger = require("./logger");
const { createProductOptionReader } = require("./product-option-reader");
const { createPublicProductPresenters } = require("./public-product-presenters");
const { createRepositoryContexts } = require("./repository-contexts");
const { createSettingsCache } = require("./settings-cache");
const { createUploadHandlers } = require("./upload-handlers");
const { createUrlHelpers } = require("./url-helpers");
const { createFormReaders } = require("./form-readers");
const {
    normalizeText,
    normalizeSingleLineText,
    toBoolean,
    parseInteger,
    parseMoneyToCents,
    parseOptionalMoneyToCents,
    normalizeOrderDateTimeField,
    formatDateTimeInputValue,
} = require("./input-utils");
const {
    getOrderPaymentData,
    getOrderReceivedAmountCents,
    getOrderReceivedDeltaCents,
    canEditOrderReceivedAmount,
    readReceivedPaymentInput,
    getOrderContactSnapshot,
    buildOrderMailto,
    getOrderAdminData,
} = require("./order-admin-helpers");
const {
    setFlash,
    getFlash,
    saveSessionAndRedirect,
    getSafeRedirectTarget,
} = require("./http/session-utils");
const { getOrCreateCsrfToken, isValidCsrfToken } = require("./http/csrf");
const { createAttemptRateLimiter, getRequestIp, startRateLimitPruning } = require("./http/rate-limiter");
const { createAdminAuth } = require("./http/admin-auth");
const { createOrderViewTokenHelpers } = require("./payments/order-view-token");
const { createStripeIntentService } = require("./payments/stripe-intents");
const {
    WEBHOOK_SECRET_HEADER,
    mapSwissBitcoinPayStatus,
    createSwissBitcoinPayService,
} = require("./payments/swiss-bitcoin-pay");
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
} = require("./shop-formatters");
const database = require("./db");

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const STRIPE_INTENT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const STRIPE_INTENT_RATE_LIMIT_BLOCK_MS = 10 * 60 * 1000;
const STRIPE_INTENT_RATE_LIMIT_MAX_ATTEMPTS = 20;
const RATE_LIMIT_MAX_KEYS = 1000;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

function createApplicationContext(options = {}) {
    const rootDir = options.rootDir;
    const appEnv = options.env || process.env;
    const config = createAppConfig({
        env: appEnv,
        rootDir,
        databasePath: options.databasePath,
    });
    const { env } = config;
    const { baseUrl, getOrderDocumentConfig, absoluteUrl } = createUrlHelpers(env);
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
    const rateLimitPruneInterval = options.startBackgroundTasks === false
        ? null
        : startRateLimitPruning([loginRateLimiter, stripeIntentRateLimiter], RATE_LIMIT_PRUNE_INTERVAL_MS);
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
        cleanupProductUploads,
        cleanupSettingsUpload,
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
    const checkoutOrderService = createCheckoutOrderService({
        db,
        buildCart,
        requirePromoCodeOutcome,
        getCheckoutPricing,
        createOrder: repositoryContexts.orders.createOrder,
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

    function render(res, view, renderOptions = {}) {
        const request = res.req;
        res.render(view, {
            ...getViewHelpers(),
            structuredData: renderOptions.structuredData ?? (request ? organizationStructuredData(request) : null),
            ...renderOptions,
        });
    }

    async function notifyNewOrder(order) {
        try {
            await sendNewOrderNotification(order);
        } catch (error) {
            logger.error(`Order notification email failed for ${order.order_number}: ${error.message}`);
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
        ...checkoutOrderService,
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
        cleanupProductUploads,
        cleanupSettingsUpload,
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

    return {
        runtime: {
            config,
            db,
            stop() {
                if (rateLimitPruneInterval) {
                    clearInterval(rateLimitPruneInterval);
                }

                db.close?.();
            },
        },
        middleware: {
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
        },
        webhookRoutes: {
            db,
            providers,
            repositories: repositoryContexts.orders,
            payments,
            text,
        },
        pageRoutes: {
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
        },
        fallbackRoutes: {
            setFlash,
            saveSessionAndRedirect,
        },
    };
}

module.exports = { createApplicationContext };
