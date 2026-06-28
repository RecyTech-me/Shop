const { createCartSessionHelpers } = require("./cart-session");
const { createCheckoutStateHelpers } = require("./checkout-state");
const { createCheckoutOrderService } = require("./checkout-order-service");
const { createMailService } = require("./mail-service");
const { createPaymentReservationCleanupService } = require("./payment-reservation-cleanup-service");
const logger = require("./logger");
const { createProductOptionReader } = require("./product-option-reader");
const { createPublicProductPresenters } = require("./public-product-presenters");
const { createUploadHandlers } = require("./upload-handlers");
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
    getOrderReceivedAmountCents,
    getOrderReceivedDeltaCents,
    canEditOrderReceivedAmount,
    getOrderContactSnapshot,
} = require("./order-admin-helpers");
const { createStripeIntentService, isStripeDraftCurrent } = require("./payments/stripe-intents");
const { mapSwissBitcoinPayStatus } = require("./payments/swiss-bitcoin-pay");
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

function createUploadDomainServices({ config, setFlash, saveSessionAndRedirect, getSafeRedirectTarget }) {
    return createUploadHandlers({
        productUploadDir: config.paths.productUploads,
        settingsUploadDir: config.paths.settingsUploads,
        setFlash,
        saveSessionAndRedirect,
        getSafeRedirectTarget,
    });
}

function createCheckoutDomainServices({ db, cart, repositories, paymentState }) {
    const checkoutState = createCheckoutStateHelpers({
        SHIPPING_OPTIONS,
        PAYMENT_DISCOUNT_RATE,
        formatMoney,
        getPromoCodeByCode: (code) => repositories.promos.getPromoCodeByCode(db, code),
        normalizeText,
        paymentState,
    });
    const checkoutOrderService = createCheckoutOrderService({
        db,
        buildCart: cart.buildCart,
        requirePromoCodeOutcome: checkoutState.requirePromoCodeOutcome,
        getCheckoutPricing: checkoutState.getCheckoutPricing,
        createOrder: repositories.orders.createOrder,
        reserveOrderInventory: repositories.orders.reserveOrderInventory,
    });

    return {
        checkoutState,
        checkoutOrderService,
    };
}

function createPaymentDomainServices({
    stripe,
    swissBitcoinPay,
    paymentState,
    cart,
    checkoutState,
    rateLimiters,
    orderViewTokens,
}) {
    const { createOrReuseStripeIntent } = createStripeIntentService({
        stripe,
        paymentState,
        buildCart: cart.buildCart,
        buildCheckoutDraft: checkoutState.buildCheckoutDraft,
        getCheckoutForm: checkoutState.getCheckoutForm,
        shippingOptions: SHIPPING_OPTIONS,
        requirePromoCodeOutcome: checkoutState.requirePromoCodeOutcome,
        getCheckoutPricing: checkoutState.getCheckoutPricing,
        getStripeDraft: checkoutState.getStripeDraft,
        setStripeDraft: checkoutState.setStripeDraft,
        getRateLimitState: rateLimiters.getStripeIntentRateLimitState,
        registerAttempt: rateLimiters.registerStripeIntentAttempt,
    });

    return {
        paymentState,
        createOrReuseStripeIntent,
        isStripeDraftCurrent,
        createOrderViewToken: orderViewTokens.createOrderViewToken,
        verifyOrderViewToken: orderViewTokens.verifyOrderViewToken,
        createSwissBitcoinPayInvoice: swissBitcoinPay.createInvoice,
        fetchSwissBitcoinPayInvoice: swissBitcoinPay.fetchInvoice,
        verifySwissBitcoinPayWebhook: swissBitcoinPay.verifyWebhook,
        mapSwissBitcoinPayStatus,
    };
}

function createMailDomainServices({ env, getCachedSettings }) {
    const mailService = createMailService({
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

    async function notifyNewOrder(order) {
        try {
            await mailService.sendNewOrderNotification(order);
        } catch (error) {
            logger.error(`Order notification email failed for ${order.order_number}: ${error.message}`);
        }
    }

    return {
        getMailConfigError: mailService.getMailConfigError,
        isMailConfigured: mailService.isMailConfigured,
        buildOrderEmailDraft: mailService.buildOrderEmailDraft,
        sendStoreEmail: mailService.sendStoreEmail,
        sendNewOrderNotification: mailService.sendNewOrderNotification,
        notifyNewOrder,
    };
}

function createReservationCleanupTimers({
    backgroundTasksEnabled,
    cleanupIntervalMs,
    paymentReservationCleanup,
}) {
    let initialTimer = null;
    let interval = null;

    function runReservationCleanup() {
        paymentReservationCleanup.cleanupStaleReservations().catch((error) => {
            logger.error(`[payments] Stale reservation cleanup task failed: ${error.message}`);
        });
    }

    if (backgroundTasksEnabled && cleanupIntervalMs > 0) {
        initialTimer = setTimeout(runReservationCleanup, 0);
        initialTimer.unref?.();
        interval = setInterval(runReservationCleanup, cleanupIntervalMs);
        interval.unref?.();
    }

    return {
        stop() {
            if (initialTimer) {
                clearTimeout(initialTimer);
            }

            if (interval) {
                clearInterval(interval);
            }
        },
    };
}

function createDomainServices({
    infrastructure,
    httpBase,
}) {
    const {
        config,
        db,
        env,
        backgroundTasksEnabled,
        orderViewTokens,
        paymentProviders,
        paymentState,
        rateLimiters,
        repositories,
        settingsCache,
        urls,
    } = infrastructure;
    const { stripe, swissBitcoinPay } = paymentProviders;
    const {
        setFlash,
        saveSessionAndRedirect,
        getSafeRedirectTarget,
    } = httpBase;
    const {
        getCachedSettings,
    } = settingsCache;
    const {
        baseUrl,
        getOrderDocumentConfig,
        absoluteUrl,
    } = urls;
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
    } = createUploadDomainServices({
        config,
        setFlash,
        saveSessionAndRedirect,
        getSafeRedirectTarget,
    });
    const publicProducts = createPublicProductPresenters({
        baseUrl,
        absoluteUrl,
        formatProductPrice,
    });
    const cart = createCartSessionHelpers({
        db,
        getProductById: repositories.products.getProductById,
        normalizeText,
        normalizeSingleLineText,
        productCategoryList: publicProducts.productCategoryList,
    });
    const {
        checkoutState,
        checkoutOrderService,
    } = createCheckoutDomainServices({
        db,
        cart,
        repositories,
        paymentState,
    });
    const formsBase = createFormReaders({ normalizePromoCode: checkoutState.normalizePromoCode });
    const { readSelectedProductOptions } = createProductOptionReader({
        normalizeText,
        getProductUnitPriceCents: cart.getProductUnitPriceCents,
    });
    const payments = createPaymentDomainServices({
        stripe,
        swissBitcoinPay,
        paymentState,
        cart,
        checkoutState,
        rateLimiters,
        orderViewTokens,
    });
    const mail = createMailDomainServices({ env, getCachedSettings });
    const paymentReservationCleanup = createPaymentReservationCleanupService({
        db,
        orders: repositories.orders,
        stripe,
        swissBitcoinPay,
        mapSwissBitcoinPayStatus,
        ttlMs: config.paymentReservations.ttlMs,
        limit: config.paymentReservations.cleanupLimit,
    });
    const reservationCleanupTimers = createReservationCleanupTimers({
        backgroundTasksEnabled,
        cleanupIntervalMs: config.paymentReservations.cleanupIntervalMs,
        paymentReservationCleanup,
    });

    function getViewHelpers() {
        return {
            formatMoney,
            formatProductPrice,
            formatDateTime,
            formatDateTimeInputValue,
            formatPromoCodeDiscount: checkoutState.formatPromoCodeDiscount,
            getOrderStatusLabel,
            getOrderStatusTone,
            getOrderProviderLabel,
            getAdminRoleLabel,
            getPromoCodeStatus: checkoutState.getPromoCodeStatus,
            getPromoCodeStatusTone: checkoutState.getPromoCodeStatusTone,
            getOrderReceivedAmountCents,
            getOrderReceivedDeltaCents,
            canEditOrderReceivedAmount,
        };
    }

    function render(res, view, renderOptions = {}) {
        const request = res.req;
        res.render(view, {
            ...getViewHelpers(),
            structuredData: renderOptions.structuredData ?? (request ? publicProducts.organizationStructuredData(request) : null),
            ...renderOptions,
        });
    }

    function validateCheckout(req) {
        return checkoutState.validateCheckoutInput(req.body);
    }

    return {
        cart,
        checkout: {
            normalizePromoCode: checkoutState.normalizePromoCode,
            getPromoCodeOutcome: checkoutState.getPromoCodeOutcome,
            requirePromoCodeOutcome: checkoutState.requirePromoCodeOutcome,
            getCheckoutPricing: checkoutState.getCheckoutPricing,
            getCheckoutForm: checkoutState.getCheckoutForm,
            buildCheckoutDraft: checkoutState.buildCheckoutDraft,
            setCheckoutForm: checkoutState.setCheckoutForm,
            clearCheckoutForm: checkoutState.clearCheckoutForm,
            getStripeDraft: checkoutState.getStripeDraft,
            clearStripeDraft: checkoutState.clearStripeDraft,
            validateCheckoutInput: checkoutState.validateCheckoutInput,
            getPromoCodeLabel: checkoutState.getPromoCodeLabel,
            ...checkoutOrderService,
        },
        formatters: {
            SHIPPING_OPTIONS,
        },
        forms: {
            ...formsBase,
            readSelectedProductOptions,
            validateCheckout,
        },
        httpServices: {
            getViewHelpers,
            render,
        },
        mail,
        maintenance: {
            cleanupStalePaymentReservations: paymentReservationCleanup.cleanupStaleReservations,
        },
        money: {
            parseMoneyToCents,
            parseOptionalMoneyToCents,
            normalizeOrderDateTimeField,
        },
        payments,
        publicProducts,
        text: {
            normalizeText,
            normalizeSingleLineText,
        },
        uploads: {
            settingsUploadUrl,
            withProductUploads,
            withSettingsUpload,
            cleanupProductUploads,
            cleanupSettingsUpload,
            productInputWithUploads,
            buildProductFormState,
        },
        uploadMiddleware: {
            isProductUploadRequest,
            withProductUploads,
            isSettingsUploadRequest,
            withSettingsUpload,
        },
        urls: {
            baseUrl,
            getOrderDocumentConfig,
        },
        stop() {
            reservationCleanupTimers.stop();
        },
    };
}

module.exports = { createDomainServices };
