const path = require("path");
const crypto = require("crypto");
const { assertUsableProductionValue } = require("./production-secrets");

function requireProductionSecrets(env, requirements) {
    if (env.NODE_ENV !== "production") {
        return;
    }

    for (const [name, options] of Object.entries(requirements)) {
        assertUsableProductionValue(name, env[name], options);
    }
}

function normalizeEnvText(env, name) {
    return String(env[name] || "").trim();
}

function parseTrustProxy(value) {
    const normalized = String(value || "").trim().toLowerCase();

    if (!normalized) {
        return 1;
    }

    if (["true", "1"].includes(normalized)) {
        return 1;
    }

    if (["false", "0"].includes(normalized)) {
        return false;
    }

    const parsed = Number.parseInt(normalized, 10);
    if (Number.isInteger(parsed) && parsed >= 0 && String(parsed) === normalized) {
        return parsed;
    }

    return value;
}

function readConfiguredPublicUrl(env) {
    return normalizeEnvText(env, "SHOP_PUBLIC_URL") || normalizeEnvText(env, "BASE_URL");
}

function isLocalPublicUrl(value) {
    try {
        const url = new URL(value);
        return ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
    } catch {
        return false;
    }
}

function isHttpOrigin(value) {
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol)
            && Boolean(url.hostname)
            && !url.username
            && !url.password
            && !url.search
            && !url.hash
            && ["", "/"].includes(url.pathname);
    } catch {
        return false;
    }
}

function isSecureHttpEndpoint(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:"
            && Boolean(url.hostname)
            && !url.username
            && !url.password
            && !url.search
            && !url.hash;
    } catch {
        return false;
    }
}

function readOriginHost(value) {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return "";
    }
}

function readAllowedHosts(env) {
    const configuredHosts = String(env.ALLOWED_HOSTS || "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
    const publicHost = env.NODE_ENV === "production"
        ? readOriginHost(readConfiguredPublicUrl(env))
        : "";

    return [...new Set([publicHost, ...configuredHosts].filter(Boolean))];
}

function readLogLevel(env) {
    const configuredLevel = normalizeEnvText(env, "LOG_LEVEL").toLowerCase();
    if (configuredLevel) {
        return configuredLevel;
    }

    return env.NODE_ENV === "test" ? "silent" : "info";
}

function readLogFormat(env) {
    return normalizeEnvText(env, "LOG_FORMAT").toLowerCase() === "json" ? "json" : "text";
}

function readBooleanFlag(value) {
    return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function readIntegerSetting(value, defaultValue, options = {}) {
    const {
        allowZero = false,
        max = Number.MAX_SAFE_INTEGER,
        min = 1,
    } = options;
    const normalized = String(value ?? "").trim();
    const parsed = /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : Number.NaN;
    const lowerBound = allowZero ? 0 : min;

    if (!Number.isInteger(parsed) || parsed < lowerBound) {
        return defaultValue;
    }

    return Math.min(parsed, max);
}

function readListenPort(value, fallback = 3000) {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
        return fallback;
    }

    const parsed = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }

    return parsed;
}

function requireProductionPaymentConfig(env) {
    if (env.NODE_ENV !== "production") {
        return;
    }

    const stripeSecretKey = normalizeEnvText(env, "STRIPE_SECRET_KEY");
    const stripePublishableKey = normalizeEnvText(env, "STRIPE_PUBLISHABLE_KEY");
    const stripeWebhookSecret = normalizeEnvText(env, "STRIPE_WEBHOOK_SECRET");
    if (Boolean(stripeSecretKey) !== Boolean(stripePublishableKey)) {
        throw new Error("Stripe requires both STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY");
    }
    assertUsableProductionValue("STRIPE_SECRET_KEY", stripeSecretKey, { required: false });
    assertUsableProductionValue("STRIPE_PUBLISHABLE_KEY", stripePublishableKey, { required: false });
    if (stripeSecretKey && stripePublishableKey && !stripeWebhookSecret) {
        throw new Error("Missing required Stripe webhook secret: STRIPE_WEBHOOK_SECRET");
    }

    assertUsableProductionValue("STRIPE_WEBHOOK_SECRET", stripeWebhookSecret, {
        required: false,
        minLength: 16,
    });

    const bitcoinApiKey = normalizeEnvText(env, "SWISS_BITCOIN_PAY_API_KEY");
    const bitcoinWebhookSecret = normalizeEnvText(env, "SWISS_BITCOIN_PAY_WEBHOOK_SECRET");
    const bitcoinApiUrl = normalizeEnvText(env, "SWISS_BITCOIN_PAY_API_URL");
    if (Boolean(bitcoinApiKey) !== Boolean(bitcoinWebhookSecret)) {
        throw new Error("Swiss Bitcoin Pay requires both SWISS_BITCOIN_PAY_API_KEY and SWISS_BITCOIN_PAY_WEBHOOK_SECRET");
    }
    assertUsableProductionValue("SWISS_BITCOIN_PAY_API_KEY", bitcoinApiKey, { required: false });
    assertUsableProductionValue("SWISS_BITCOIN_PAY_WEBHOOK_SECRET", bitcoinWebhookSecret, {
        required: false,
        minLength: 24,
    });

    if (bitcoinApiKey && bitcoinApiUrl && !isSecureHttpEndpoint(bitcoinApiUrl)) {
        throw new Error("SWISS_BITCOIN_PAY_API_URL must be an HTTPS endpoint without credentials, query, or fragment");
    }
}

function requireProductionPublicUrl(env) {
    if (env.NODE_ENV !== "production") {
        return;
    }

    const publicUrl = readConfiguredPublicUrl(env);
    if (!publicUrl) {
        throw new Error("Missing required production URL: SHOP_PUBLIC_URL or BASE_URL");
    }

    if (!isHttpOrigin(publicUrl)) {
        throw new Error("SHOP_PUBLIC_URL or BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment");
    }

    if (new URL(publicUrl).protocol !== "https:" || isLocalPublicUrl(publicUrl)) {
        throw new Error("SHOP_PUBLIC_URL or BASE_URL must be a public HTTPS origin in production");
    }
}

function createAppConfig({ env = process.env, rootDir, databasePath = "" }) {
    requireProductionSecrets(env, {
        SESSION_SECRET: { minLength: 32 },
        ORDER_VIEW_TOKEN_SECRET: { minLength: 32 },
    });
    requireProductionPublicUrl(env);
    requireProductionPaymentConfig(env);

    return {
        env,
        http: {
            allowedHosts: readAllowedHosts(env),
            trustProxy: parseTrustProxy(env.TRUST_PROXY),
        },
        logging: {
            format: readLogFormat(env),
            level: readLogLevel(env),
            requestLogs: readBooleanFlag(env.REQUEST_LOGS),
        },
        paths: {
            database: String(databasePath || env.DATABASE_PATH || "").trim() || path.join(rootDir, "storage", "shop.db"),
            productUploads: path.join(rootDir, "public", "uploads", "products"),
            settingsUploads: path.join(rootDir, "public", "uploads", "settings"),
            publicDir: path.join(rootDir, "public"),
            uploadsDir: path.join(rootDir, "public", "uploads"),
            viewsDir: path.join(rootDir, "views"),
        },
        session: {
            secret: String(env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")).trim(),
        },
        orderViews: {
            tokenSecret: String(env.ORDER_VIEW_TOKEN_SECRET || "").trim(),
        },
        stripe: {
            secretKey: normalizeEnvText(env, "STRIPE_SECRET_KEY"),
            publishableKey: normalizeEnvText(env, "STRIPE_PUBLISHABLE_KEY"),
            webhookSecret: normalizeEnvText(env, "STRIPE_WEBHOOK_SECRET"),
        },
        swissBitcoinPay: {
            apiUrl: normalizeEnvText(env, "SWISS_BITCOIN_PAY_API_URL"),
            apiKey: normalizeEnvText(env, "SWISS_BITCOIN_PAY_API_KEY"),
            webhookSecret: normalizeEnvText(env, "SWISS_BITCOIN_PAY_WEBHOOK_SECRET"),
        },
        paymentReservations: {
            ttlMs: readIntegerSetting(env.PAYMENT_RESERVATION_TTL_MINUTES, 60, { min: 5, max: 24 * 60 }) * 60 * 1000,
            cleanupIntervalMs: readIntegerSetting(env.PAYMENT_RESERVATION_CLEANUP_INTERVAL_MINUTES, 15, {
                allowZero: true,
                max: 24 * 60,
            }) * 60 * 1000,
            cleanupLimit: readIntegerSetting(env.PAYMENT_RESERVATION_CLEANUP_LIMIT, 25, { min: 1, max: 250 }),
        },
    };
}

module.exports = { createAppConfig, readListenPort };
