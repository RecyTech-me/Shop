const Stripe = require("stripe");
const { createAppConfig } = require("./config");
const logger = require("./logger");
const {
    getOrderPaymentData,
    canEditOrderReceivedAmount,
    readReceivedPaymentInput,
    getOrderContactSnapshot,
    buildOrderMailto,
    getOrderAdminData,
} = require("./order-admin-helpers");
const { createRepositoryContexts } = require("./repository-contexts");
const { createSettingsCache } = require("./settings-cache");
const { createUrlHelpers } = require("./url-helpers");
const { normalizeText } = require("./input-utils");
const { createAttemptRateLimiter, getRequestIp, startRateLimitPruning } = require("./http/rate-limiter");
const { createOrderViewTokenHelpers } = require("./payments/order-view-token");
const {
    WEBHOOK_SECRET_HEADER,
    createSwissBitcoinPayService,
} = require("./payments/swiss-bitcoin-pay");
const database = require("./db");

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const STRIPE_INTENT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const STRIPE_INTENT_RATE_LIMIT_BLOCK_MS = 10 * 60 * 1000;
const STRIPE_INTENT_RATE_LIMIT_MAX_ATTEMPTS = 20;
const REVIEW_SUBMISSION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const REVIEW_SUBMISSION_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const REVIEW_SUBMISSION_RATE_LIMIT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_MAX_KEYS = 1000;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

function createInfrastructureContext(options = {}) {
    const rootDir = options.rootDir;
    const appEnv = options.env || process.env;
    const config = createAppConfig({
        env: appEnv,
        rootDir,
        databasePath: options.databasePath,
    });
    logger.configureLogger(config.logging);
    const { env } = config;
    const urls = createUrlHelpers(env);
    const db = database.initializeDatabase(config.paths.database, env);
    const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;
    const stripePublishableKey = config.stripe.publishableKey;
    const settingsCache = createSettingsCache({
        db,
        getSettings: database.getSettings,
        saveSettings: database.saveSettings,
    });
    const repositoryContexts = createRepositoryContexts({
        database,
        settings: {
            getSettings: settingsCache.getCachedSettings,
            saveSettings: settingsCache.saveCachedSettings,
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
    const orderViewTokens = createOrderViewTokenHelpers(config.orderViews.tokenSecret);
    const swissBitcoinPay = createSwissBitcoinPayService({
        apiUrl: config.swissBitcoinPay.apiUrl,
        apiKey: config.swissBitcoinPay.apiKey,
        webhookSecret: config.swissBitcoinPay.webhookSecret,
        webhookSecretHeader: WEBHOOK_SECRET_HEADER,
        baseUrl: urls.baseUrl,
        createOrderViewToken: orderViewTokens.createOrderViewToken,
    });
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
    const reviewSubmissionRateLimiter = createAttemptRateLimiter({
        windowMs: REVIEW_SUBMISSION_RATE_LIMIT_WINDOW_MS,
        blockMs: REVIEW_SUBMISSION_RATE_LIMIT_BLOCK_MS,
        maxAttempts: REVIEW_SUBMISSION_RATE_LIMIT_MAX_ATTEMPTS,
        maxKeys: RATE_LIMIT_MAX_KEYS,
    });
    const rateLimitPruneInterval = options.startBackgroundTasks === false
        ? null
        : startRateLimitPruning([loginRateLimiter, stripeIntentRateLimiter, reviewSubmissionRateLimiter], RATE_LIMIT_PRUNE_INTERVAL_MS);

    function paymentState() {
        return {
            stripeEnabled: Boolean(stripe && stripePublishableKey),
            stripePublishableKey,
            bitcoinEnabled: Boolean(swissBitcoinPay.apiKey && swissBitcoinPay.webhookSecret),
            transferEnabled: true,
        };
    }

    return {
        backgroundTasksEnabled: options.startBackgroundTasks !== false,
        config,
        db,
        env,
        orderViewTokens,
        paymentProviders: {
            stripe,
            stripePublishableKey,
            swissBitcoinPay,
        },
        paymentState,
        rateLimiters: {
            getLoginRateLimitState: (req) => loginRateLimiter.getState(req),
            registerLoginAttempt: (req) => loginRateLimiter.registerAttempt(req),
            clearLoginAttempts: (req) => loginRateLimiter.clear(req),
            getStripeIntentRateLimitState: (req) => stripeIntentRateLimiter.getState(req),
            registerStripeIntentAttempt: (req) => stripeIntentRateLimiter.registerAttempt(req),
            getReviewSubmissionRateLimitState: (req) => reviewSubmissionRateLimiter.getState(req),
            registerReviewSubmissionAttempt: (req) => reviewSubmissionRateLimiter.registerAttempt(req),
        },
        repositories: repositoryContexts,
        settingsCache,
        urls,
        stop() {
            if (rateLimitPruneInterval) {
                clearInterval(rateLimitPruneInterval);
            }

            db.close?.();
        },
    };
}

module.exports = { createInfrastructureContext };
