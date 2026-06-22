require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const path = require("path");
const crypto = require("crypto");
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
const { createMailService } = require("./lib/mail-service");
const { createPublicProductPresenters } = require("./lib/public-product-presenters");
const { createUploadHandlers } = require("./lib/upload-handlers");
const { createUrlHelpers } = require("./lib/url-helpers");
const {
    SHIPPING_OPTIONS,
    PAYMENT_DISCOUNT_RATE,
    ORDER_STATUS_OPTIONS,
    ADMIN_ROLE_OPTIONS,
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

const env = process.env;
const isProduction = env.NODE_ENV === "production";
const missingProductionSecrets = [
    ["SESSION_SECRET", env.SESSION_SECRET],
    ["ORDER_VIEW_TOKEN_SECRET", env.ORDER_VIEW_TOKEN_SECRET],
]
    .filter(([, value]) => !String(value || "").trim())
    .map(([name]) => name);

if (isProduction && missingProductionSecrets.length) {
    throw new Error(`Missing required production secret(s): ${missingProductionSecrets.join(", ")}`);
}

const { baseUrl, getOrderDocumentConfig, absoluteUrl } = createUrlHelpers(env);
const app = express();
const databasePath = path.join(__dirname, "storage", "shop.db");
const db = initializeDatabase(databasePath, env);
const productUploadDir = path.join(__dirname, "public", "uploads", "products");
const settingsUploadDir = path.join(__dirname, "public", "uploads", "settings");
const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;
const stripePublishableKey = env.STRIPE_PUBLISHABLE_KEY || "";
const swissBitcoinPayApiUrl = (env.SWISS_BITCOIN_PAY_API_URL || "https://api.swiss-bitcoin-pay.ch").replace(/\/$/, "");
const swissBitcoinPayApiKey = String(env.SWISS_BITCOIN_PAY_API_KEY || "").trim();
const swissBitcoinPayWebhookSecret = String(env.SWISS_BITCOIN_PAY_WEBHOOK_SECRET || "").trim();
const swissBitcoinPayWebhookSecretHeader = "x-recytech-webhook-secret";
const sessionSecret = String(env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")).trim();
const orderViewTokenSecret = String(env.ORDER_VIEW_TOKEN_SECRET || "").trim();
const loginAttemptTracker = new Map();
const stripeIntentTracker = new Map();

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const STRIPE_INTENT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const STRIPE_INTENT_RATE_LIMIT_BLOCK_MS = 10 * 60 * 1000;
const STRIPE_INTENT_RATE_LIMIT_MAX_ATTEMPTS = 20;
const RATE_LIMIT_MAX_KEYS = 1000;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

const rateLimitPruneInterval = setInterval(() => {
    pruneAttemptTracker(loginAttemptTracker, LOGIN_RATE_LIMIT_WINDOW_MS);
    pruneAttemptTracker(stripeIntentTracker, STRIPE_INTENT_RATE_LIMIT_WINDOW_MS);
}, RATE_LIMIT_PRUNE_INTERVAL_MS);
rateLimitPruneInterval.unref?.();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/static/uploads", express.static(path.join(__dirname, "public", "uploads"), {
    maxAge: "5m",
}));
app.use("/static", express.static(path.join(__dirname, "public"), {
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
    productUploadDir,
    settingsUploadDir,
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
    getAllowedPaymentMethods,
    getPreferredPaymentMethod,
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
    getMailConfigError,
    isMailConfigured,
    buildOrderEmailDraft,
    sendStoreEmail,
    sendNewOrderNotification,
} = createMailService({
    env,
    getSettings: () => getSettings(db),
    normalizeText,
    parseInteger,
    toBoolean,
    formatMoney,
    formatDateTime,
    getOrderContactSnapshot,
    getOrderProviderLabel,
    getOrderStatusLabel,
});

function setFlash(req, type, message, options = {}) {
    req.session.flash = { type, message, ...options };
}

function getFlash(req) {
    const flash = req.session.flash || null;
    delete req.session.flash;
    return flash;
}

function paymentState() {
    return {
        stripeEnabled: Boolean(stripe && stripePublishableKey),
        stripePublishableKey,
        bitcoinEnabled: Boolean(swissBitcoinPayApiKey && swissBitcoinPayWebhookSecret),
        transferEnabled: true,
    };
}

function mapSwissBitcoinPayStatus(invoice) {
    const normalized = String(invoice?.status || "").toLowerCase();

    if (invoice?.isPaid || normalized === "paid") {
        return "paid";
    }

    if (invoice?.isExpired || normalized === "expired") {
        return "failed";
    }

    return "pending";
}

function requireAdmin(req, res, next) {
    const currentAdmin = req.currentAdmin || (req.session.adminId ? getAdminById(db, req.session.adminId) : null);
    if (!currentAdmin) {
        req.session.adminId = null;
        return res.redirect("/admin/login");
    }

    req.currentAdmin = currentAdmin;
    res.locals.currentAdmin = currentAdmin;
    next();
}

function requireSuperadmin(req, res, next) {
    const currentAdmin = req.currentAdmin || (req.session.adminId ? getAdminById(db, req.session.adminId) : null);
    if (!currentAdmin) {
        req.session.adminId = null;
        return res.redirect("/admin/login");
    }

    if (currentAdmin.role !== "superadmin") {
        setFlash(req, "error", "Accès réservé aux superadmins.");
        return saveSessionAndRedirect(req, res, "/admin");
    }

    req.currentAdmin = currentAdmin;
    res.locals.currentAdmin = currentAdmin;
    next();
}

function buildSwissBitcoinPayDescription(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const preview = items.slice(0, 3).map((item) => `${item.quantity} x ${item.name}`);

    if (items.length > 3) {
        preview.push(`+${items.length - 3} autre(s) article(s)`);
    }

    return preview.join(", ") || `Commande ${order.order_number}`;
}

async function createSwissBitcoinPayInvoice(order, req) {
    const response = await fetch(
        `${swissBitcoinPayApiUrl}/checkout`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "api-key": swissBitcoinPayApiKey,
            },
            body: JSON.stringify({
                amount: Number((order.amount_cents / 100).toFixed(2)),
                title: `Commande ${order.order_number}`,
                description: buildSwissBitcoinPayDescription(order),
                unit: order.currency,
                onChain: true,
                delay: 10,
                email: order.customer_email,
                emailLanguage: "fr",
                redirect: false,
                redirectAfterPaid: `${baseUrl(req)}/checkout/success?provider=swissbitcoinpay&order=${encodeURIComponent(order.order_number)}&view=${encodeURIComponent(createOrderViewToken(order))}`,
                webhook: {
                    url: `${baseUrl(req)}/webhooks/swiss-bitcoin-pay`,
                    headers: {
                        [swissBitcoinPayWebhookSecretHeader]: swissBitcoinPayWebhookSecret,
                    },
                },
                device: {
                    name: "RecyTech Shop",
                    type: "website",
                },
                extra: {
                    orderNumber: order.order_number,
                },
            }),
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Swiss Bitcoin Pay invoice creation failed: ${response.status} ${text}`);
    }

    const invoice = await response.json();

    if (!invoice?.checkoutUrl) {
        throw new Error("Swiss Bitcoin Pay n'a pas retourné d'URL de paiement.");
    }

    return invoice;
}

async function fetchSwissBitcoinPayInvoice(invoiceId) {
    const response = await fetch(`${swissBitcoinPayApiUrl}/checkout/${encodeURIComponent(invoiceId)}`);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Swiss Bitcoin Pay invoice fetch failed: ${response.status} ${text}`);
    }

    return response.json();
}

function getOrderPaymentData(order) {
    return order?.metadata?.payment && typeof order.metadata.payment === "object"
        ? order.metadata.payment
        : {};
}

function getOrderReceivedAmountCents(order) {
    const amountCents = Number.parseInt(getOrderPaymentData(order).received_amount_cents, 10);
    return Number.isInteger(amountCents) && amountCents >= 0 ? amountCents : null;
}

function getOrderReceivedDeltaCents(order) {
    const receivedAmountCents = getOrderReceivedAmountCents(order);
    return receivedAmountCents === null ? null : receivedAmountCents - (order.amount_cents || 0);
}

function canEditOrderReceivedAmount(order) {
    return ["cash", "transfer", "manual"].includes(order?.provider);
}

function readReceivedPaymentInput(values, order) {
    const currentPaymentData = getOrderPaymentData(order);
    const nextPaymentData = { ...currentPaymentData };
    const amountCents = parseOptionalMoneyToCents(values.actual_received_chf, "Montant réellement reçu");

    if (amountCents === null) {
        delete nextPaymentData.received_amount_cents;
        delete nextPaymentData.received_amount_recorded_at;
    } else {
        nextPaymentData.received_amount_cents = amountCents;
        nextPaymentData.received_amount_recorded_at = currentPaymentData.received_amount_recorded_at || new Date().toISOString();
    }

    return nextPaymentData;
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
    res.render(view, {
        ...getViewHelpers(),
        ...options,
    });
}

function saveSessionAndRedirect(req, res, location) {
    req.session.save(() => {
        res.redirect(location);
    });
}

function getSafeRedirectTarget(value, fallback = "/") {
    const input = normalizeText(value);
    if (!input || !input.startsWith("/") || input.startsWith("//") || /[\r\n\\]/.test(input)) {
        return fallback;
    }

    return input;
}

function normalizeText(value) {
    return String(value || "").trim();
}

function normalizeSingleLineText(value) {
    return normalizeText(value).replace(/[\r\n]+/g, " ");
}

function truncateText(value, maxLength) {
    const text = normalizeText(value);
    return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function readSiteReviewInput(values) {
    const rating = Number.parseInt(values.rating, 10);
    const reviewerName = truncateText(values.reviewer_name, 80);
    const reviewerEmail = normalizeSingleLineText(values.reviewer_email).slice(0, 160);
    const title = truncateText(values.title, 120);
    const body = truncateText(values.body, 1200);

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new Error("Choisissez une note entre 1 et 5.");
    }

    if (!reviewerName) {
        throw new Error("Votre nom est obligatoire.");
    }

    if (reviewerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reviewerEmail)) {
        throw new Error("Adresse e-mail invalide.");
    }

    if (body.length < 10) {
        throw new Error("Votre avis doit contenir au moins 10 caractères.");
    }

    return {
        rating,
        reviewer_name: reviewerName,
        reviewer_email: reviewerEmail,
        title,
        body,
    };
}

function getRequestIp(req) {
    return normalizeText(req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
}

function pruneAttemptTracker(tracker, windowMs, now = Date.now()) {
    for (const [key, value] of tracker.entries()) {
        const expiresAt = Math.max(value.blockedUntil || 0, (value.firstAttemptAt || 0) + windowMs);
        if (!expiresAt || expiresAt <= now) {
            tracker.delete(key);
        }
    }

    while (tracker.size > RATE_LIMIT_MAX_KEYS) {
        tracker.delete(tracker.keys().next().value);
    }
}

function getLoginRateLimitState(req) {
    pruneAttemptTracker(loginAttemptTracker, LOGIN_RATE_LIMIT_WINDOW_MS);
    const key = getRequestIp(req);
    const now = Date.now();
    const current = loginAttemptTracker.get(key);

    if (!current) {
        return {
            key,
            attempts: 0,
            blockedUntil: 0,
        };
    }

    if (current.blockedUntil && current.blockedUntil > now) {
        return {
            key,
            attempts: current.attempts || LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
            blockedUntil: current.blockedUntil,
        };
    }

    if (!current.firstAttemptAt || (now - current.firstAttemptAt) > LOGIN_RATE_LIMIT_WINDOW_MS) {
        loginAttemptTracker.delete(key);
        return {
            key,
            attempts: 0,
            blockedUntil: 0,
        };
    }

    return {
        key,
        attempts: current.attempts || 0,
        blockedUntil: 0,
    };
}

function registerLoginFailure(req) {
    const state = getLoginRateLimitState(req);
    const now = Date.now();
    const nextAttempts = state.attempts + 1;
    const nextState = {
        firstAttemptAt: state.attempts ? loginAttemptTracker.get(state.key)?.firstAttemptAt || now : now,
        attempts: nextAttempts,
        blockedUntil: nextAttempts >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS ? now + LOGIN_RATE_LIMIT_BLOCK_MS : 0,
    };

    loginAttemptTracker.set(state.key, nextState);
    pruneAttemptTracker(loginAttemptTracker, LOGIN_RATE_LIMIT_WINDOW_MS, now);
}

function clearLoginFailures(req) {
    loginAttemptTracker.delete(getRequestIp(req));
}

function getStripeIntentRateLimitKey(req) {
    return `${getRequestIp(req)}:${normalizeText(req.sessionID) || "anonymous"}`;
}

function getStripeIntentRateLimitState(req) {
    pruneAttemptTracker(stripeIntentTracker, STRIPE_INTENT_RATE_LIMIT_WINDOW_MS);
    const key = getStripeIntentRateLimitKey(req);
    const now = Date.now();
    const current = stripeIntentTracker.get(key);

    if (!current) {
        return { key, attempts: 0, blockedUntil: 0 };
    }

    if (current.blockedUntil && current.blockedUntil > now) {
        return {
            key,
            attempts: current.attempts || STRIPE_INTENT_RATE_LIMIT_MAX_ATTEMPTS,
            blockedUntil: current.blockedUntil,
        };
    }

    if (!current.firstAttemptAt || (now - current.firstAttemptAt) > STRIPE_INTENT_RATE_LIMIT_WINDOW_MS) {
        stripeIntentTracker.delete(key);
        return { key, attempts: 0, blockedUntil: 0 };
    }

    return {
        key,
        attempts: current.attempts || 0,
        blockedUntil: 0,
    };
}

function registerStripeIntentAttempt(req) {
    const state = getStripeIntentRateLimitState(req);
    const now = Date.now();
    const nextAttempts = state.attempts + 1;

    stripeIntentTracker.set(state.key, {
        firstAttemptAt: state.attempts ? stripeIntentTracker.get(state.key)?.firstAttemptAt || now : now,
        attempts: nextAttempts,
        blockedUntil: nextAttempts >= STRIPE_INTENT_RATE_LIMIT_MAX_ATTEMPTS ? now + STRIPE_INTENT_RATE_LIMIT_BLOCK_MS : 0,
    });
    pruneAttemptTracker(stripeIntentTracker, STRIPE_INTENT_RATE_LIMIT_WINDOW_MS, now);
}

function clearStripeIntentAttempts(req) {
    stripeIntentTracker.delete(getStripeIntentRateLimitKey(req));
}

function getOrCreateCsrfToken(req) {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(24).toString("hex");
    }

    return req.session.csrfToken;
}

function isValidCsrfToken(req) {
    const sessionToken = req.session?.csrfToken;
    const incomingToken = normalizeText(req.body?._csrf || req.headers["x-csrf-token"] || req.headers["csrf-token"]);

    if (!sessionToken || !incomingToken) {
        return false;
    }

    const expected = Buffer.from(sessionToken, "utf8");
    const provided = Buffer.from(incomingToken, "utf8");

    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function createOrderViewToken(order) {
    if (!order || !orderViewTokenSecret) {
        return "";
    }

    return crypto
        .createHmac("sha256", orderViewTokenSecret)
        .update([order.order_number, order.customer_email, order.amount_cents, order.provider].join("|"))
        .digest("base64url");
}

function verifyOrderViewToken(order, token) {
    const expected = createOrderViewToken(order);
    const provided = normalizeText(token);

    if (!expected || !provided) {
        return false;
    }

    const expectedBuffer = Buffer.from(expected, "utf8");
    const providedBuffer = Buffer.from(provided, "utf8");

    return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function readAdminUserInput(values, options = {}) {
    const username = normalizeText(values.username);
    const role = normalizeText(values.role) || "admin";
    const password = String(values.password || "").trim();

    if (!username) {
        throw new Error("Le nom d'utilisateur est obligatoire.");
    }

    if (!ADMIN_ROLE_OPTIONS.some((option) => option.value === role)) {
        throw new Error("Rôle administrateur invalide.");
    }

    if (options.requirePassword && !password) {
        throw new Error("Le mot de passe est obligatoire.");
    }

    return {
        username,
        role,
        password,
    };
}

function readAdminAccountInput(values, currentAdmin) {
    const username = normalizeText(values.username);
    const currentPassword = String(values.current_password || "").trim();
    const password = String(values.password || "").trim();
    const passwordConfirm = String(values.password_confirm || "").trim();

    if (!username) {
        throw new Error("Le nom d'utilisateur est obligatoire.");
    }

    if (password && password !== passwordConfirm) {
        throw new Error("La confirmation du nouveau mot de passe ne correspond pas.");
    }

    const usernameChanged = username !== currentAdmin.username;
    const passwordChanged = Boolean(password);

    if ((usernameChanged || passwordChanged) && !currentPassword) {
        throw new Error("Le mot de passe actuel est requis pour modifier vos identifiants.");
    }

    return {
        username,
        currentPassword,
        password,
        usernameChanged,
        passwordChanged,
    };
}

function formatAddressLines(parts) {
    return parts.map(normalizeText).filter(Boolean);
}

function getOrderContactSnapshot(order) {
    const checkout = order.metadata?.checkout || {};
    const shippingLines = formatAddressLines([
        `${checkout.shipping_first_name || checkout.customer_first_name || ""} ${checkout.shipping_last_name || checkout.customer_last_name || ""}`.trim(),
        checkout.shipping_address1,
        [checkout.shipping_postal_code, checkout.shipping_city].filter(Boolean).join(" "),
        checkout.shipping_region,
        checkout.shipping_country,
    ]);
    const billingLines = formatAddressLines([
        `${checkout.billing_first_name || ""} ${checkout.billing_last_name || ""}`.trim(),
        checkout.billing_address1,
        [checkout.billing_postal_code, checkout.billing_city].filter(Boolean).join(" "),
        checkout.billing_region,
        checkout.billing_country,
    ]);
    const phone = checkout.shipping_phone || checkout.billing_phone || "";

    return {
        checkout,
        phone,
        shippingLines,
        billingLines,
    };
}

function buildOrderMailto(order, subjectPrefix = "Commande") {
    const subject = `${subjectPrefix} ${order.order_number}`;
    const body = [
        `Bonjour ${order.customer_name},`,
        "",
        `Nous vous contactons au sujet de votre commande ${order.order_number}.`,
        "",
        "Bien à vous,",
        "RecyTech",
    ].join("\n");

    return `mailto:${encodeURIComponent(order.customer_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function toBoolean(value) {
    return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseInteger(value, fallback) {
    const parsed = Number.parseInt(String(value || "").trim(), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseMoneyToCents(value, fallback = 0) {
    const normalized = String(value || "").trim().replace(",", ".");
    if (!normalized) {
        return fallback;
    }

    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.round(parsed * 100);
}

function parseOptionalMoneyToCents(value, fieldLabel) {
    const rawValue = String(value || "").trim();
    if (!rawValue) {
        return null;
    }

    const amountCents = parseMoneyToCents(rawValue, Number.NaN);
    if (!Number.isFinite(amountCents) || amountCents < 0) {
        throw new Error(`${fieldLabel} invalide.`);
    }

    return amountCents;
}

function normalizeDateField(value) {
    const normalized = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function normalizeOrderDateTimeField(value, fallback = "") {
    const normalized = normalizeText(value);
    if (!normalized) {
        return fallback;
    }

    const parsed = new Date(normalized);
    if (!Number.isFinite(parsed.valueOf())) {
        throw new Error("Date de commande invalide.");
    }

    return parsed.toISOString();
}

function formatDateTimeInputValue(value = new Date()) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.valueOf())) {
        return "";
    }

    return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function readPromoCodeInput(values) {
    const code = normalizePromoCode(values.code);
    const description = normalizeText(values.description);
    const discountType = normalizeText(values.discount_type) === "fixed" ? "fixed" : "percent";
    const amountValue = String(values.amount_value || "").trim();
    const minimumOrderCents = Math.max(0, parseMoneyToCents(values.minimum_order_chf, 0));
    const maxRedemptionsRaw = String(values.max_redemptions || "").trim();
    const startsOn = normalizeDateField(values.starts_on);
    const expiresOn = normalizeDateField(values.expires_on);

    if (!code) {
        throw new Error("Le code promo est obligatoire.");
    }

    let discountValue = 0;

    if (discountType === "percent") {
        const parsedPercent = parseInteger(amountValue, NaN);
        if (!Number.isFinite(parsedPercent) || parsedPercent <= 0 || parsedPercent > 100) {
            throw new Error("Le pourcentage doit être compris entre 1 et 100.");
        }

        discountValue = parsedPercent;
    } else {
        discountValue = parseMoneyToCents(amountValue, NaN);
        if (!Number.isFinite(discountValue) || discountValue <= 0) {
            throw new Error("Le montant fixe doit être supérieur à 0.");
        }
    }

    let maxRedemptions = null;
    if (maxRedemptionsRaw) {
        maxRedemptions = parseInteger(maxRedemptionsRaw, NaN);
        if (!Number.isFinite(maxRedemptions) || maxRedemptions <= 0) {
            throw new Error("La limite d'utilisation doit être un entier positif.");
        }
    }

    if (startsOn && expiresOn && startsOn > expiresOn) {
        throw new Error("La date de fin doit être postérieure à la date de début.");
    }

    return {
        code,
        description,
        discount_type: discountType,
        discount_value: discountValue,
        minimum_order_cents: minimumOrderCents,
        max_redemptions: maxRedemptions,
        starts_on: startsOn || null,
        expires_on: expiresOn || null,
        active: values.active ? 1 : 0,
    };
}

function verifySwissBitcoinPaySignature(rawBody, signatureHeader) {
    if (!swissBitcoinPayWebhookSecret) {
        return false;
    }

    const signature = String(signatureHeader || "").trim();
    if (!signature) {
        return false;
    }

    const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
    const digest = crypto.createHmac("sha256", swissBitcoinPayWebhookSecret).update(payload).digest();
    const candidates = [signature, signature.replace(/^sha256=/i, "").trim()].filter(Boolean);

    for (const candidate of candidates) {
        if (/^[a-f0-9]+$/i.test(candidate) && candidate.length === digest.length * 2) {
            const buffer = Buffer.from(candidate, "hex");
            if (buffer.length === digest.length && crypto.timingSafeEqual(buffer, digest)) {
                return true;
            }
        }

        const normalizedBase64 = candidate.replace(/-/g, "+").replace(/_/g, "/");
        const paddedBase64 = normalizedBase64 + "=".repeat((4 - (normalizedBase64.length % 4 || 4)) % 4);

        try {
            const buffer = Buffer.from(paddedBase64, "base64");
            if (buffer.length === digest.length && crypto.timingSafeEqual(buffer, digest)) {
                return true;
            }
        } catch (error) {
            // Ignore invalid encodings and keep trying supported formats.
        }
    }

    return false;
}

function timingSafeEqualText(actual, expected) {
    const actualBuffer = Buffer.from(String(actual || ""), "utf8");
    const expectedBuffer = Buffer.from(String(expected || ""), "utf8");

    if (!actualBuffer.length || actualBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function verifySwissBitcoinPayWebhook(req) {
    if (!swissBitcoinPayWebhookSecret) {
        return false;
    }

    const customSecret = Array.isArray(req.headers[swissBitcoinPayWebhookSecretHeader])
        ? req.headers[swissBitcoinPayWebhookSecretHeader][0]
        : req.headers[swissBitcoinPayWebhookSecretHeader];

    if (timingSafeEqualText(customSecret, swissBitcoinPayWebhookSecret)) {
        return true;
    }

    // Backward-compatible fallback for older/manual integrations that send an HMAC signature.
    return verifySwissBitcoinPaySignature(req.body, req.headers["sbp-sig"]);
}

async function notifyNewOrder(order) {
    try {
        await sendNewOrderNotification(order);
    } catch (error) {
        console.error(`Order notification email failed for ${order.order_number}: ${error.message}`);
    }
}

function getOrderAdminData(order) {
    return order.metadata?.admin || {};
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

function getCartSignature(cart) {
    return cart.items
        .map((item) => `${item.item_key}:${item.quantity}:${item.unit_price_cents}`)
        .join("|");
}

function validateCheckout(req) {
    return validateCheckoutInput(req.body);
}

async function createOrReuseStripeIntent(req, values = {}) {
    if (!paymentState().stripeEnabled) {
        throw new Error("Le paiement par carte est indisponible.");
    }

    const cart = buildCart(req);
    if (!cart.items.length) {
        throw new Error("Le panier est vide.");
    }

    const draftForm = buildCheckoutDraft(values, getCheckoutForm(req));
    const shippingOption = SHIPPING_OPTIONS[draftForm.delivery_method] || SHIPPING_OPTIONS.pickup;
    const promoCodeOutcome = requirePromoCodeOutcome(draftForm.promo_code, cart.subtotalCents);
    const pricing = getCheckoutPricing(cart.subtotalCents, shippingOption, "card", promoCodeOutcome);
    const amountCents = pricing.totalCents;
    const cartSignature = getCartSignature(cart);
    const draft = getStripeDraft(req);

    if (
        draft &&
        draft.amountCents === amountCents &&
        draft.deliveryMethod === draftForm.delivery_method &&
        draft.promoCode === promoCodeOutcome.code &&
        draft.cartSignature === cartSignature &&
        draft.paymentIntentId &&
        draft.clientSecret
    ) {
        return draft;
    }

    const rateLimitState = getStripeIntentRateLimitState(req);
    if (rateLimitState.blockedUntil > Date.now()) {
        throw new Error("Trop de tentatives de paiement carte. Réessayez dans quelques minutes.");
    }

    registerStripeIntentAttempt(req);

    const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "chf",
        payment_method_types: ["card"],
        receipt_email: draftForm.customer_email || undefined,
        metadata: {
            source: "recytech-shop",
            delivery_method: draftForm.delivery_method,
            promo_code: promoCodeOutcome.code || "",
        },
    });

    const nextDraft = {
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amountCents,
        deliveryMethod: draftForm.delivery_method,
        promoCode: promoCodeOutcome.code,
        cartSignature,
    };

    setStripeDraft(req, nextDraft);
    return nextDraft;
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
        secret: sessionSecret,
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
    res.locals.settings = getSettings(db);
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
    getSettings,
    saveSettings,
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

app.use((error, req, res, next) => {
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

const port = Number.parseInt(env.PORT || "3000", 10);
const host = env.HOST || "127.0.0.1";

app.listen(port, host, () => {
    console.log(`RecyTech shop listening on http://${host}:${port}`);
});
