require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");
const { SqliteSessionStore, SESSION_TTL_MS } = require("./lib/sqlite-session-store");
const { registerAdminRoutes } = require("./routes/admin");
const { registerCheckoutRoutes } = require("./routes/checkout");
const { registerPublicApiRoutes } = require("./routes/public-api");
const { registerStorefrontRoutes } = require("./routes/storefront");
const { registerWebhookRoutes } = require("./routes/webhooks");
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
const orderViewTokenSecret = String(env.ORDER_VIEW_TOKEN_SECRET || env.SESSION_SECRET || "").trim();
const loginAttemptTracker = new Map();
const stripeIntentTracker = new Map();

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const STRIPE_INTENT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const STRIPE_INTENT_RATE_LIMIT_BLOCK_MS = 10 * 60 * 1000;
const STRIPE_INTENT_RATE_LIMIT_MAX_ATTEMPTS = 20;

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/static", express.static(path.join(__dirname, "public")));

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

function getCartItems(req) {
    return Array.isArray(req.session.cart) ? req.session.cart : [];
}

function setCartItems(req, items) {
    req.session.cart = items;
}

function getConfigurationSelections(configuration) {
    if (Array.isArray(configuration)) {
        return configuration;
    }

    if (Array.isArray(configuration?.selections)) {
        return configuration.selections;
    }

    return [];
}

function findProductConfiguration(product, selectedOptions = []) {
    const configurations = Array.isArray(product.valid_configurations)
        ? product.valid_configurations
        : [];

    if (!configurations.length) {
        return null;
    }

    return configurations.find((configuration) => {
        const selections = getConfigurationSelections(configuration);
        return selections.length === selectedOptions.length && selections.every((selection, index) =>
            selection.name === selectedOptions[index]?.name &&
            selection.value === selectedOptions[index]?.value
        );
    }) || null;
}

function getConfigurationAvailableQuantity(product, selectedOptions = []) {
    const configurations = Array.isArray(product.valid_configurations)
        ? product.valid_configurations
        : [];

    if (!configurations.length) {
        return Math.max(0, product.inventory);
    }

    const configuration = findProductConfiguration(product, selectedOptions);
    if (!configuration) {
        return 0;
    }

    const configurationQuantity = Number.isInteger(configuration.quantity) && configuration.quantity >= 0
        ? configuration.quantity
        : product.inventory;

    return Math.max(0, Math.min(product.inventory, configurationQuantity));
}

function ensureAvailableProductQuantity(product, selectedOptions = [], requestedQuantity = 1) {
    const availableQuantity = getConfigurationAvailableQuantity(product, selectedOptions);

    if (availableQuantity <= 0) {
        throw new Error(product.option_groups?.length
            ? "Cette combinaison d'options est en rupture de stock."
            : "Ce produit est en rupture de stock.");
    }

    if (requestedQuantity > availableQuantity) {
        throw new Error(`Stock insuffisant : ${availableQuantity} unité(s) disponible(s).`);
    }

    return availableQuantity;
}

function validateRequestedServiceTags(product, selectedOptions = [], requestedServiceTags = [], requestedQuantity = 1) {
    const configuration = findProductConfiguration(product, selectedOptions);
    const availableServiceTags = Array.isArray(configuration?.service_tags)
        ? [...new Set(configuration.service_tags.map((tag) => normalizeSingleLineText(tag)).filter(Boolean))]
        : [];
    const normalizedRequestedTags = [...new Set(
        (Array.isArray(requestedServiceTags) ? requestedServiceTags : [requestedServiceTags])
            .map((tag) => normalizeSingleLineText(tag))
            .filter(Boolean)
    )];

    if (!normalizedRequestedTags.length && !availableServiceTags.length) {
        return [];
    }

    if (normalizedRequestedTags.some((tag) => !availableServiceTags.includes(tag))) {
        throw new Error("Le ou les tags de service choisis ne correspondent pas à cette combinaison.");
    }

    if (normalizedRequestedTags.length > requestedQuantity) {
        throw new Error("Le nombre de tags de service choisis dépasse la quantité vendue.");
    }

    const requiredTagCount = Math.min(requestedQuantity, availableServiceTags.length);
    if (requiredTagCount > 0 && normalizedRequestedTags.length !== requiredTagCount) {
        throw new Error(requiredTagCount === 1
            ? "Veuillez choisir le tag de service vendu."
            : `Veuillez choisir exactement ${requiredTagCount} tags de service.`);
    }

    return normalizedRequestedTags;
}

function getProductUnitPriceCents(product, selectedOptions = []) {
    if (product?.is_pack) {
        return product.price_cents;
    }

    const configurations = Array.isArray(product.valid_configurations)
        ? product.valid_configurations
        : [];

    if (!configurations.length) {
        return product.price_cents;
    }

    const configuration = findProductConfiguration(product, selectedOptions);
    if (!configuration) {
        throw new Error("Cette combinaison d'options n'est pas disponible.");
    }

    return Number.isInteger(configuration.price_cents)
        ? configuration.price_cents
        : product.price_cents;
}

function snapshotPackBundleItems(product) {
    if (!product?.is_pack || !Array.isArray(product.bundle_items)) {
        return [];
    }

    return product.bundle_items.map((item) => ({
        product_id: item.product_id,
        slug: item.slug,
        name: item.name,
        quantity: item.quantity,
        selected_options: Array.isArray(item.selected_options)
            ? item.selected_options.map((option) => ({ ...option }))
            : [],
        service_tags: [],
    }));
}

function buildCart(req) {
    const rawItems = getCartItems(req);
    const items = [];

    for (const rawItem of rawItems) {
        const product = getProductById(db, rawItem.productId);
        if (!product || !product.published) {
            continue;
        }

        const selectedOptions = Array.isArray(rawItem.selectedOptions)
            ? rawItem.selectedOptions
                .map((option) => ({
                    name: normalizeText(option?.name),
                    value: normalizeText(option?.value),
                }))
                .filter((option) => option.name && option.value)
            : [];
        let unitPriceCents = product.price_cents;
        let availableQuantity = product.inventory;

        try {
            unitPriceCents = getProductUnitPriceCents(product, selectedOptions);
            availableQuantity = getConfigurationAvailableQuantity(product, selectedOptions);
        } catch {
            continue;
        }

        if (availableQuantity <= 0) {
            continue;
        }

        const quantity = Math.min(Math.max(1, rawItem.quantity), availableQuantity);

        items.push({
            product_id: product.id,
            item_key: rawItem.itemKey || `${product.id}:${JSON.stringify(selectedOptions)}`,
            slug: product.slug,
            name: product.name,
            product_kind: product.product_kind,
            is_pack: Boolean(product.is_pack),
            category: product.category,
            categories: productCategoryList(product),
            short_description: product.short_description,
            image_url: product.image_url,
            selected_options: selectedOptions,
            bundle_items: snapshotPackBundleItems(product),
            quantity,
            unit_price_cents: unitPriceCents,
            line_total_cents: unitPriceCents * quantity,
            inventory: availableQuantity,
        });
    }

    const subtotalCents = items.reduce((sum, item) => sum + item.line_total_cents, 0);

    return {
        items,
        subtotalCents,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    };
}

function getAllowedPaymentMethods(deliveryMethod) {
    const methods = [];
    const state = paymentState();

    if (state.stripeEnabled) {
        methods.push("card");
    }

    methods.push("transfer");

    if (state.bitcoinEnabled) {
        methods.push("bitcoin");
    }

    if (deliveryMethod === "pickup") {
        methods.push("cash");
    }

    return methods;
}

function getPreferredPaymentMethod(deliveryMethod) {
    return getAllowedPaymentMethods(deliveryMethod)[0] || "transfer";
}

function normalizePromoCode(value) {
    return String(value || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
}

function todayIsoDate() {
    const value = new Date();
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getPaymentDiscountLabel(paymentMethod) {
    if (paymentMethod === "bitcoin") {
        return "Réduction Bitcoin (-10%)";
    }

    if (paymentMethod === "cash") {
        return "Réduction retrait espèces (-10%)";
    }

    return "";
}

function getPromoCodeLabel(promoCode) {
    return `Code promo ${promoCode.code}`;
}

function formatPromoCodeDiscount(promoCode) {
    if (!promoCode) {
        return "";
    }

    if (promoCode.discount_type === "percent") {
        return `-${promoCode.discount_percent}%`;
    }

    return `-${formatMoney(promoCode.discount_cents || 0)}`;
}

function getPromoCodeStatus(promoCode) {
    if (!promoCode) {
        return "Inconnu";
    }

    if (!promoCode.active) {
        return "Désactivé";
    }

    const today = todayIsoDate();

    if (promoCode.starts_on && today < promoCode.starts_on) {
        return "Planifié";
    }

    if (promoCode.expires_on && today > promoCode.expires_on) {
        return "Expiré";
    }

    if (
        Number.isInteger(promoCode.max_redemptions) &&
        promoCode.max_redemptions > 0 &&
        promoCode.times_redeemed >= promoCode.max_redemptions
    ) {
        return "Épuisé";
    }

    return "Actif";
}

function getPromoCodeStatusTone(promoCode) {
    const status = getPromoCodeStatus(promoCode);

    if (status === "Actif") {
        return "success";
    }

    if (status === "Planifié") {
        return "info";
    }

    if (["Expiré", "Épuisé", "Désactivé"].includes(status)) {
        return "muted";
    }

    return "muted";
}

function getPromoCodeOutcome(codeValue, subtotalCents) {
    const normalizedCode = normalizePromoCode(codeValue);
    if (!normalizedCode) {
        return {
            code: "",
            promoCode: null,
            discountCents: 0,
            label: "",
            error: "",
        };
    }

    const promoCode = getPromoCodeByCode(db, normalizedCode);
    if (!promoCode) {
        return {
            code: normalizedCode,
            promoCode: null,
            discountCents: 0,
            label: "",
            error: "Ce code promo n'existe pas.",
        };
    }

    if (!promoCode.active) {
        return {
            code: normalizedCode,
            promoCode,
            discountCents: 0,
            label: "",
            error: "Ce code promo est désactivé.",
        };
    }

    const today = todayIsoDate();

    if (promoCode.starts_on && today < promoCode.starts_on) {
        return {
            code: normalizedCode,
            promoCode,
            discountCents: 0,
            label: "",
            error: "Ce code promo n'est pas encore actif.",
        };
    }

    if (promoCode.expires_on && today > promoCode.expires_on) {
        return {
            code: normalizedCode,
            promoCode,
            discountCents: 0,
            label: "",
            error: "Ce code promo a expiré.",
        };
    }

    if (
        Number.isInteger(promoCode.max_redemptions) &&
        promoCode.max_redemptions > 0 &&
        promoCode.times_redeemed >= promoCode.max_redemptions
    ) {
        return {
            code: normalizedCode,
            promoCode,
            discountCents: 0,
            label: "",
            error: "Ce code promo a déjà atteint sa limite d'utilisation.",
        };
    }

    if ((subtotalCents || 0) < (promoCode.minimum_order_cents || 0)) {
        return {
            code: normalizedCode,
            promoCode,
            discountCents: 0,
            label: "",
            error: `Ce code promo nécessite une commande d'au moins ${formatMoney(promoCode.minimum_order_cents || 0)}.`,
        };
    }

    const discountCents = promoCode.discount_type === "percent"
        ? Math.round((subtotalCents || 0) * ((promoCode.discount_percent || 0) / 100))
        : Math.min(promoCode.discount_cents || 0, subtotalCents || 0);

    if (discountCents <= 0) {
        return {
            code: normalizedCode,
            promoCode,
            discountCents: 0,
            label: "",
            error: "Ce code promo ne peut pas être appliqué à cette commande.",
        };
    }

    return {
        code: normalizedCode,
        promoCode,
        discountCents,
        label: getPromoCodeLabel(promoCode),
        error: "",
    };
}

function requirePromoCodeOutcome(codeValue, subtotalCents) {
    const outcome = getPromoCodeOutcome(codeValue, subtotalCents);
    if (outcome.code && outcome.error) {
        throw new Error(outcome.error);
    }

    return outcome;
}

function getCheckoutPricing(subtotalCents, shippingOption, paymentMethod, promoCodeOutcome = null) {
    const shippingCents = shippingOption?.priceCents || 0;
    const promoDiscountCents = promoCodeOutcome?.discountCents || 0;
    const remainingSubtotalCents = Math.max((subtotalCents || 0) - promoDiscountCents, 0);
    const paymentDiscountCents = ["bitcoin", "cash"].includes(paymentMethod)
        ? Math.round(remainingSubtotalCents * PAYMENT_DISCOUNT_RATE)
        : 0;
    const discountLines = [];

    if (promoDiscountCents > 0 && promoCodeOutcome?.promoCode) {
        discountLines.push({
            type: "discount",
            code: promoCodeOutcome.promoCode.code,
            label: promoCodeOutcome.label,
            amount_cents: -promoDiscountCents,
        });
    }

    if (paymentDiscountCents > 0) {
        discountLines.push({
            type: "discount",
            label: getPaymentDiscountLabel(paymentMethod),
            amount_cents: -paymentDiscountCents,
        });
    }

    const discountCents = promoDiscountCents + paymentDiscountCents;

    return {
        subtotalCents: subtotalCents || 0,
        shippingCents,
        promoDiscountCents,
        promoDiscountLabel: promoDiscountCents > 0 ? promoCodeOutcome.label : "",
        paymentDiscountCents,
        paymentDiscountLabel: paymentDiscountCents > 0 ? getPaymentDiscountLabel(paymentMethod) : "",
        discountCents,
        discountLabel: discountLines.map((line) => line.label).join(" + "),
        discountLines,
        totalCents: Math.max(0, (subtotalCents || 0) + shippingCents - discountCents),
    };
}

function normalizeCheckoutFormState(form) {
    const nextForm = {
        ...form,
    };

    if (!["ship", "pickup"].includes(nextForm.delivery_method)) {
        nextForm.delivery_method = "ship";
    }

    const allowedPaymentMethods = getAllowedPaymentMethods(nextForm.delivery_method);
    if (!allowedPaymentMethods.includes(nextForm.payment_method)) {
        nextForm.payment_method = getPreferredPaymentMethod(nextForm.delivery_method);
    }

    if (nextForm.delivery_method === "pickup") {
        nextForm.billing_same_as_shipping = "0";
    }

    return nextForm;
}

function getDefaultCheckoutForm() {
    return {
        customer_email: "",
        customer_first_name: "",
        customer_last_name: "",
        delivery_method: "ship",
        pickup_location: "recytech-center",
        shipping_country: "Suisse",
        shipping_address1: "",
        shipping_postal_code: "",
        shipping_city: "",
        shipping_region: "Neuchâtel",
        shipping_phone: "",
        billing_same_as_shipping: "1",
        billing_country: "Suisse",
        billing_first_name: "",
        billing_last_name: "",
        billing_address1: "",
        billing_postal_code: "",
        billing_city: "",
        billing_region: "Neuchâtel",
        billing_phone: "",
        payment_method: getPreferredPaymentMethod("ship"),
        promo_code: "",
        order_note: "",
    };
}

function getCheckoutForm(req) {
    return normalizeCheckoutFormState({
        ...getDefaultCheckoutForm(),
        ...(req.session.checkoutForm || {}),
    });
}

function buildCheckoutDraft(values, currentForm = getDefaultCheckoutForm()) {
    const draft = {
        ...currentForm,
    };

    const textFields = [
        "customer_email",
        "customer_first_name",
        "customer_last_name",
        "pickup_location",
        "shipping_country",
        "shipping_address1",
        "shipping_postal_code",
        "shipping_city",
        "shipping_region",
        "shipping_phone",
        "billing_country",
        "billing_first_name",
        "billing_last_name",
        "billing_address1",
        "billing_postal_code",
        "billing_city",
        "billing_region",
        "billing_phone",
        "order_note",
    ];

    for (const field of textFields) {
        if (values[field] !== undefined) {
            draft[field] = normalizeText(values[field]);
        }
    }

    if (["ship", "pickup"].includes(values.delivery_method)) {
        draft.delivery_method = values.delivery_method;
    }

    if (["card", "transfer", "bitcoin", "cash"].includes(values.payment_method)) {
        draft.payment_method = values.payment_method;
    }

    if (values.promo_code !== undefined) {
        draft.promo_code = normalizePromoCode(values.promo_code);
    }

    if (values.billing_same_as_shipping !== undefined) {
        draft.billing_same_as_shipping = values.billing_same_as_shipping === "1" ? "1" : "0";
    }

    return normalizeCheckoutFormState(draft);
}

function setCheckoutForm(req, values) {
    req.session.checkoutForm = values;
}

function clearCheckoutForm(req) {
    delete req.session.checkoutForm;
}

function getStripeDraft(req) {
    return req.session.stripeDraft || null;
}

function setStripeDraft(req, draft) {
    req.session.stripeDraft = draft;
}

function clearStripeDraft(req) {
    delete req.session.stripeDraft;
}

function makeCartItemKey(productId, selectedOptions = []) {
    return `${productId}:${JSON.stringify(selectedOptions)}`;
}

function upsertCartItem(req, productId, quantity, selectedOptions = []) {
    const cart = getCartItems(req);
    const nextQuantity = Math.max(1, quantity);
    const itemKey = makeCartItemKey(productId, selectedOptions);
    const existing = cart.find((item) => (item.itemKey || makeCartItemKey(item.productId, item.selectedOptions || [])) === itemKey);

    if (existing) {
        existing.quantity = nextQuantity;
    } else {
        cart.push({ productId, quantity: nextQuantity, selectedOptions, itemKey });
    }

    setCartItems(req, cart);
}

function removeCartItem(req, itemKey) {
    setCartItems(
        req,
        getCartItems(req).filter((item) => (item.itemKey || makeCartItemKey(item.productId, item.selectedOptions || [])) !== itemKey)
    );
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

function getLoginRateLimitState(req) {
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
}

function clearLoginFailures(req) {
    loginAttemptTracker.delete(getRequestIp(req));
}

function getStripeIntentRateLimitKey(req) {
    return `${getRequestIp(req)}:${normalizeText(req.sessionID) || "anonymous"}`;
}

function getStripeIntentRateLimitState(req) {
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

function getMailSettings(settings) {
    return {
        host: normalizeText(settings.smtp_host || env.SMTP_HOST),
        port: parseInteger(settings.smtp_port || env.SMTP_PORT, 587),
        secure: toBoolean(settings.smtp_secure || env.SMTP_SECURE),
        username: normalizeText(settings.smtp_username || env.SMTP_USERNAME),
        password: String(settings.smtp_password || env.SMTP_PASSWORD || "").trim(),
        fromName: normalizeText(settings.smtp_from_name || env.SMTP_FROM_NAME || settings.store_name || "RecyTech"),
        fromEmail: normalizeText(settings.smtp_from_email || env.SMTP_FROM_EMAIL || settings.support_email),
    };
}

function getMailConfigError(settings) {
    const config = getMailSettings(settings);

    if (!config.host) {
        return "Serveur SMTP manquant.";
    }

    if (!config.port) {
        return "Port SMTP invalide.";
    }

    if (!config.fromEmail) {
        return "Adresse expéditeur manquante.";
    }

    if ((config.username && !config.password) || (!config.username && config.password)) {
        return "Les identifiants SMTP sont incomplets.";
    }

    return "";
}

function isMailConfigured(settings) {
    return !getMailConfigError(settings);
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatEmailHtml(text) {
    return String(text || "")
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
        .join("");
}

function buildOrderEmailDraft(order) {
    return {
        subject: `Commande ${order.order_number}`,
        message: [
            `Bonjour ${order.customer_name},`,
            "",
            `Nous vous contactons au sujet de votre commande ${order.order_number}.`,
            "",
            "Bien à vous,",
            "RecyTech",
        ].join("\n"),
    };
}

function getOrderNotificationRecipient(settings) {
    return normalizeText(settings.order_notification_email || env.ORDER_NOTIFICATION_EMAIL || "team@recytech.me");
}

function formatOrderNotificationItems(order) {
    return (order.items || []).map((item) => {
        const optionText = Array.isArray(item.selected_options) && item.selected_options.length
            ? ` (${item.selected_options.map((option) => `${option.name}: ${option.value}`).join(", ")})`
            : "";
        return `- ${item.quantity} x ${item.name}${optionText} : ${formatMoney(item.line_total_cents || (item.unit_price_cents * item.quantity), order.currency)}`;
    }).join("\n");
}

function buildNewOrderNotification(order) {
    const contact = getOrderContactSnapshot(order);
    const delivery = order.metadata?.delivery || {};
    const deliveryLabel = delivery.label || (delivery.method === "ship" ? "Expédition" : "Retrait");
    const additions = Array.isArray(order.metadata?.additions) ? order.metadata.additions : [];
    const additionsText = additions.length
        ? additions.map((line) => `- ${line.label} : ${formatMoney(line.amount_cents, order.currency)}`).join("\n")
        : "Aucun supplément";
    const adminUrl = `${env.BASE_URL || ""}/admin/orders/${order.id}`;

    return {
        subject: `Nouvelle commande ${order.order_number}`,
        text: [
            "Une nouvelle commande a été enregistrée sur la boutique RecyTech.",
            "",
            `Numéro : ${order.order_number}`,
            `Date : ${formatDateTime(order.created_at)}`,
            `Client : ${order.customer_name}`,
            `E-mail : ${order.customer_email}`,
            contact.phone ? `Téléphone : ${contact.phone}` : null,
            `Paiement : ${getOrderProviderLabel(order.provider)}`,
            `Statut : ${getOrderStatusLabel(order.status)}`,
            `Total : ${formatMoney(order.amount_cents, order.currency)}`,
            `Livraison : ${deliveryLabel}`,
            "",
            "Articles :",
            formatOrderNotificationItems(order) || "- Aucun article",
            "",
            "Suppléments :",
            additionsText,
            contact.shippingLines.length ? "" : null,
            contact.shippingLines.length ? "Adresse de livraison :" : null,
            ...(contact.shippingLines.length ? contact.shippingLines : []),
            contact.billingLines.length ? "" : null,
            contact.billingLines.length ? "Adresse de facturation :" : null,
            ...(contact.billingLines.length ? contact.billingLines : []),
            adminUrl.startsWith("http") ? "" : null,
            adminUrl.startsWith("http") ? `Administration : ${adminUrl}` : null,
        ].filter(Boolean).join("\n"),
    };
}

async function sendStoreEmail(settings, message) {
    const configError = getMailConfigError(settings);
    if (configError) {
        throw new Error(configError);
    }

    const config = getMailSettings(settings);
    const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.username ? { user: config.username, pass: config.password } : undefined,
    });

    return transporter.sendMail({
        from: {
            name: config.fromName,
            address: config.fromEmail,
        },
        replyTo: settings.support_email || config.fromEmail,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: formatEmailHtml(message.text),
    });
}

async function sendNewOrderNotification(order) {
    const settings = getSettings(db);
    const recipient = getOrderNotificationRecipient(settings);

    if (!recipient || !isMailConfigured(settings)) {
        return;
    }

    const notification = buildNewOrderNotification(order);
    await sendStoreEmail(settings, {
        to: recipient,
        subject: notification.subject,
        text: notification.text,
    });
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

function validateCheckoutInput(values) {
    const billingSameAsShipping =
        values.billing_same_as_shipping === "1" ||
        values.billing_same_as_shipping === 1 ||
        values.billing_same_as_shipping === true;

    const form = {
        customer_email: normalizeText(values.customer_email),
        customer_first_name: normalizeText(values.customer_first_name),
        customer_last_name: normalizeText(values.customer_last_name),
        delivery_method: normalizeText(values.delivery_method) || "pickup",
        pickup_location: normalizeText(values.pickup_location) || "recytech-center",
        shipping_country: normalizeText(values.shipping_country) || "Suisse",
        shipping_address1: normalizeText(values.shipping_address1),
        shipping_postal_code: normalizeText(values.shipping_postal_code),
        shipping_city: normalizeText(values.shipping_city),
        shipping_region: normalizeText(values.shipping_region) || "Neuchâtel",
        shipping_phone: normalizeText(values.shipping_phone),
        billing_same_as_shipping: billingSameAsShipping ? "1" : "0",
        billing_country: normalizeText(values.billing_country) || "Suisse",
        billing_first_name: normalizeText(values.billing_first_name),
        billing_last_name: normalizeText(values.billing_last_name),
        billing_address1: normalizeText(values.billing_address1),
        billing_postal_code: normalizeText(values.billing_postal_code),
        billing_city: normalizeText(values.billing_city),
        billing_region: normalizeText(values.billing_region) || "Neuchâtel",
        billing_phone: normalizeText(values.billing_phone),
        payment_method: normalizeText(values.payment_method) || getPreferredPaymentMethod(normalizeText(values.delivery_method) || "pickup"),
        promo_code: normalizePromoCode(values.promo_code),
        order_note: normalizeText(values.order_note),
    };

    if (!form.customer_email || !form.customer_first_name || !form.customer_last_name) {
        throw new Error("Les coordonnées de contact sont obligatoires.");
    }

    if (!["ship", "pickup"].includes(form.delivery_method)) {
        form.delivery_method = "pickup";
    }

    if (!["card", "transfer", "bitcoin", "cash"].includes(form.payment_method)) {
        form.payment_method = getPreferredPaymentMethod(form.delivery_method);
    }

    if (form.payment_method === "cash" && form.delivery_method !== "pickup") {
        throw new Error("Le paiement en espèces est disponible uniquement pour le retrait.");
    }

    if (form.delivery_method === "pickup") {
        form.billing_same_as_shipping = "0";
    }

    if (form.delivery_method === "ship") {
        const shippingFields = [
            form.shipping_address1,
            form.shipping_postal_code,
            form.shipping_city,
        ];

        if (shippingFields.some((value) => !value)) {
            throw new Error("L'adresse de livraison est incomplète.");
        }
    }

    if (form.billing_same_as_shipping === "0") {
        const billingFields = [
            form.billing_first_name,
            form.billing_last_name,
            form.billing_address1,
            form.billing_postal_code,
            form.billing_city,
        ];

        if (billingFields.some((value) => !value)) {
            throw new Error("L'adresse de facturation est incomplète.");
        }
    } else {
        form.billing_country = form.shipping_country;
        form.billing_first_name = form.customer_first_name;
        form.billing_last_name = form.customer_last_name;
        form.billing_address1 = form.shipping_address1;
        form.billing_postal_code = form.shipping_postal_code;
        form.billing_city = form.shipping_city;
        form.billing_region = form.shipping_region;
        form.billing_phone = form.shipping_phone;
    }

    const shippingOption = SHIPPING_OPTIONS[form.delivery_method] || SHIPPING_OPTIONS.pickup;
    const customerName = `${form.customer_first_name} ${form.customer_last_name}`.trim();

    return {
        form,
        customer: {
            name: customerName,
            email: form.customer_email,
        },
        shippingOption,
    };
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
        secret: env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
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
