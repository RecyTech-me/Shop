require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");
const { verifyPassword } = require("./lib/auth");
const { SqliteSessionStore, SESSION_TTL_MS } = require("./lib/sqlite-session-store");
const { buildOrderDocumentPdf, buildOrderDocumentFilename } = require("./lib/order-documents");
const {
    initializeDatabase,
    getSettings,
    saveSettings,
    createProduct,
    updateProduct,
    deleteProduct,
    listPublishedProducts,
    listFeaturedProducts,
    listAdminProducts,
    listProductCategories,
    getProductBySlug,
    getProductById,
    getAdminByUsername,
    getAdminById,
    listAdmins,
    countAdminsByRole,
    createAdmin: createAdminUser,
    updateAdmin: updateAdminUser,
    deleteAdmin: deleteAdminUser,
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

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/static", express.static(path.join(__dirname, "public")));

function createImageUpload(uploadDir, maxFiles) {
    return multer({
        storage: multer.diskStorage({
            destination: (req, file, callback) => {
                callback(null, uploadDir);
            },
            filename: (req, file, callback) => {
                const extensionByMimeType = {
                    "image/jpeg": ".jpg",
                    "image/png": ".png",
                    "image/webp": ".webp",
                    "image/gif": ".gif",
                };
                const extension = extensionByMimeType[file.mimetype] || ".img";
                callback(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`);
            },
        }),
        limits: {
            fileSize: 8 * 1024 * 1024,
            files: maxFiles,
        },
        fileFilter: (req, file, callback) => {
            if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)) {
                return callback(new Error("Seules les images JPG, PNG, WebP ou GIF peuvent être importées."));
            }

            callback(null, true);
        },
    });
}

const productImageUpload = createImageUpload(productUploadDir, 13);
const settingsImageUpload = createImageUpload(settingsUploadDir, 1);

function formatMoney(cents, currency = "CHF") {
    return new Intl.NumberFormat("fr-CH", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
    }).format((cents || 0) / 100);
}

function formatProductPrice(product) {
    if (product?.has_configuration_pricing) {
        return `À partir de ${formatMoney(product.starting_price_cents, product.currency)}`;
    }

    return formatMoney(product?.price_cents || 0, product?.currency || "CHF");
}

const SHIPPING_OPTIONS = {
    ship: {
        key: "ship",
        label: "La Poste",
        priceCents: 1150,
    },
    pickup: {
        key: "pickup",
        label: "Retrait au point de retrait",
        priceCents: 0,
    },
};

const PAYMENT_DISCOUNT_RATE = 0.1;

const ORDER_STATUS_OPTIONS = [
    { value: "pending", label: "En attente" },
    { value: "awaiting_transfer", label: "En attente du virement" },
    { value: "paid", label: "Payée" },
    { value: "processing", label: "En préparation" },
    { value: "ready_for_pickup", label: "Prête au retrait" },
    { value: "shipped", label: "Expédiée" },
    { value: "completed", label: "Terminée" },
    { value: "cancelled", label: "Annulée" },
    { value: "failed", label: "Échouée" },
    { value: "refunded", label: "Remboursée" },
];

const ADMIN_ROLE_OPTIONS = [
    { value: "admin", label: "Admin" },
    { value: "superadmin", label: "Superadmin" },
];

function getOrderStatusLabel(status) {
    return ORDER_STATUS_OPTIONS.find((option) => option.value === status)?.label || status;
}

function getOrderStatusTone(status) {
    if (["paid", "completed", "ready_for_pickup"].includes(status)) {
        return "success";
    }

    if (["cancelled", "failed", "refunded"].includes(status)) {
        return "danger";
    }

    if (["processing", "shipped"].includes(status)) {
        return "info";
    }

    return "muted";
}

function getAdminRoleLabel(role) {
    return ADMIN_ROLE_OPTIONS.find((option) => option.value === role)?.label || role;
}

function getOrderProviderLabel(provider) {
    if (provider === "stripe") {
        return "Carte bancaire (Stripe)";
    }

    if (provider === "manual") {
        return "Commande manuelle";
    }

    if (provider === "transfer") {
        return "Virement bancaire";
    }

    if (provider === "cash") {
        return "Paiement en espèces";
    }

    if (provider === "swissbitcoinpay") {
        return "Bitcoin (Swiss Bitcoin Pay)";
    }

    return provider;
}

function formatDateTime(value) {
    if (!value) {
        return "";
    }

    return new Intl.DateTimeFormat("fr-CH", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));
}

function getLegalPages(settings) {
    const supportEmail = settings.support_email || "contact@recytech.me";
    const supportAddress = settings.support_address || "Rue Louis-Favre 62, 2017 Boudry";

    return {
        "politique-confidentialite": {
            title: "Politique de confidentialité",
            heading: "Politique de confidentialité",
            intro: "Cette politique décrit les données traitées par la boutique RecyTech, les finalités de traitement et les droits des personnes concernées.",
            sections: [
                {
                    title: "Responsable du traitement",
                    paragraphs: [
                        `Le responsable du traitement des données personnelles collectées via la boutique est RecyTech, joignable à l'adresse ${supportAddress} et par e-mail à ${supportEmail}.`,
                        "Cette politique s'applique aux données traitées lors de la consultation du site, de l'utilisation du panier, de la validation d'une commande et des échanges de support liés à la boutique.",
                    ],
                    bullets: [],
                },
                {
                    title: "Ce que nous collectons et stockons",
                    paragraphs: [
                        "Pendant votre visite et lors d'une commande, nous collectons uniquement les informations nécessaires au fonctionnement de la boutique et à l'exécution du contrat.",
                        "Le site ne propose actuellement ni compte client, ni commentaires publics, ni système d'avis. Il ne stocke pas non plus les données complètes de carte bancaire sur ses propres serveurs.",
                    ],
                    bullets: [
                        "le contenu du panier et certaines préférences de commande, au moyen d'une session technique et de cookies strictement nécessaires au fonctionnement du site",
                        "les coordonnées de contact et de commande : nom, e-mail, adresses de facturation et de livraison, téléphone si vous le fournissez, notes de commande",
                        "les détails de commande : produits commandés, mode de livraison, mode de paiement, montant, numéro de commande et statut de paiement",
                        "les références techniques transmises par les prestataires de paiement lorsque vous choisissez Stripe, Swiss Bitcoin Pay ou le virement bancaire",
                    ],
                },
                {
                    title: "Pourquoi nous utilisons ces données",
                    paragraphs: [
                        "Nous utilisons ces données pour traiter la commande, organiser la livraison ou le retrait, enregistrer le paiement, émettre une facture ou un récapitulatif de commande, répondre aux demandes de support et respecter nos obligations administratives et comptables.",
                        "Les données de session et de panier servent également à maintenir l'état du panier et à mémoriser temporairement les informations saisies dans le formulaire de commande.",
                    ],
                    bullets: [
                        "traitement et suivi des commandes",
                        "gestion des paiements et prévention des abus ou erreurs de paiement",
                        "organisation de l'expédition ou du retrait",
                        "service client, remboursement et gestion des retours",
                        "respect des obligations légales, fiscales et comptables",
                    ],
                },
                {
                    title: "Partage avec des tiers",
                    paragraphs: [
                        "Nous ne vendons pas vos données personnelles. Nous les communiquons uniquement lorsque cela est nécessaire à l'exploitation de la boutique ou imposé par la loi.",
                        "Selon le mode de paiement choisi, certaines données peuvent être transmises à nos prestataires de paiement, à des prestataires logistiques ou à notre infrastructure d'envoi d'e-mails afin de permettre l'exécution de la commande et le suivi client.",
                    ],
                    bullets: [
                        "prestataires de paiement, notamment Stripe pour le paiement par carte et Swiss Bitcoin Pay pour le paiement bitcoin",
                        "prestataires de livraison ou transporteurs lorsque vous choisissez une expédition",
                        "prestataire SMTP ou infrastructure d'envoi d'e-mails lorsqu'un message relatif à la commande vous est adressé depuis l'administration de la boutique",
                        "autorités ou conseillers lorsque la loi l'exige ou lorsqu'il faut faire valoir ou défendre des droits",
                    ],
                },
                {
                    title: "Cookies et technologies similaires",
                    paragraphs: [
                        "La boutique utilise des cookies et une session technique strictement nécessaires afin de faire fonctionner le panier, conserver temporairement vos informations de commande et sécuriser la navigation.",
                        "À la date de publication de cette politique, la boutique n'utilise pas de cookies publicitaires ni de suivi marketing tiers sur son front principal.",
                    ],
                    bullets: [],
                },
                {
                    title: "Durée de conservation",
                    paragraphs: [
                        "Les données de session et de panier sont conservées temporairement pendant la navigation ou jusqu'à expiration de la session.",
                        "Les informations de commande et de facturation sont conservées aussi longtemps que nécessaire pour le traitement de la commande puis pendant la durée requise par les obligations légales applicables, notamment comptables et fiscales.",
                        "À ce jour, RecyTech prévoit une conservation pouvant aller jusqu'à 10 ans pour les documents et données de commande utiles à la comptabilité et à la défense des droits.",
                    ],
                    bullets: [],
                },
                {
                    title: "Vos droits",
                    paragraphs: [
                        "Conformément au droit suisse applicable, vous pouvez notamment demander l'accès à vos données personnelles, leur rectification et, lorsque les conditions légales sont réunies, leur suppression ou la limitation de certains traitements.",
                        `Pour exercer vos droits ou poser une question relative à la protection des données, contactez RecyTech à ${supportEmail}.`,
                    ],
                    bullets: [
                        "droit d'accès aux données traitées",
                        "droit de rectification des données inexactes",
                        "droit de demander la suppression dans la mesure compatible avec les obligations légales de conservation",
                        "droit d'obtenir des informations sur les destinataires de vos données et, le cas échéant, sur certains transferts à l'étranger",
                    ],
                },
            ],
        },
        "conditions-generales-de-vente": {
            title: "Conditions générales de vente",
            heading: "Conditions générales de vente",
            intro: "Les présentes conditions générales de vente s'appliquent aux ventes effectuées via la boutique RecyTech.",
            sections: [
                {
                    title: "Identité du vendeur et champ d'application",
                    paragraphs: [
                        `Le site shop.recytech.me est exploité par RecyTech, joignable à ${supportAddress} et par e-mail à ${supportEmail}.`,
                        "Les présentes conditions s'appliquent à toute commande passée sur la boutique par un client privé ou professionnel, sauf accord écrit contraire.",
                    ],
                    bullets: [],
                },
                {
                    title: "Produits, disponibilité et informations",
                    paragraphs: [
                        "Les produits proposés sont présentés avec leur dénomination, leur état, leur prix et, lorsque l'information est disponible, leur stock. Les photographies et descriptions ont une valeur informative et ne constituent pas une garantie absolue d'identité parfaite.",
                        "Les produits sont vendus dans la limite des stocks disponibles. En cas d'indisponibilité ou d'erreur manifeste, RecyTech peut contacter l'acheteur afin de proposer une solution appropriée, y compris le remboursement.",
                    ],
                    bullets: [],
                },
                {
                    title: "Commande et conclusion du contrat",
                    paragraphs: [
                        "Le client sélectionne les produits, vérifie son panier, renseigne les informations demandées puis valide sa commande. Le site permet de corriger les erreurs de saisie avant l'envoi final de la commande.",
                        "Après validation, un récapitulatif de commande est affiché et la commande est enregistrée dans le système de la boutique. Le contrat est conclu lorsque RecyTech accepte la commande, notamment par l'enregistrement de celle-ci et, le cas échéant, par l'encaissement ou le traitement du paiement.",
                    ],
                    bullets: [],
                },
                {
                    title: "Prix et paiement",
                    paragraphs: [
                        "Les prix sont indiqués en CHF, sauf mention contraire. Les frais de livraison ou de retrait payants sont affichés avant validation définitive de la commande.",
                        "Le paiement peut être effectué selon les options rendues disponibles sur le site au moment de la commande, en particulier par carte bancaire, bitcoin, virement bancaire ou en espèces lors d'un retrait lorsque cette option est proposée.",
                        "Lorsque le paiement est traité par un prestataire externe, les conditions et contrôles du prestataire concernent également la transaction.",
                    ],
                    bullets: [],
                },
                {
                    title: "Livraison et retrait",
                    paragraphs: [
                        "Les produits sont remis soit par expédition, soit par retrait selon les options proposées au moment de la commande.",
                        "Les délais de livraison ou de mise à disposition sont indicatifs, sauf engagement écrit contraire. L'acheteur doit vérifier l'état apparent du colis et signaler sans délai tout dommage ou toute erreur de livraison.",
                    ],
                    bullets: [],
                },
                {
                    title: "Garantie et réclamations",
                    paragraphs: [
                        "L'acheteur doit signaler les défauts constatés dès que possible après la réception. Les droits légaux en matière de défauts restent réservés dans la mesure du droit applicable.",
                        "Pour les appareils d'occasion ou reconditionnés, RecyTech prévoit une garantie contractuelle de 12 mois, sous réserve des exclusions mentionnées dans la présente politique et des droits légaux impératifs.",
                        "La garantie ne couvre pas les dommages liés à une mauvaise utilisation, à une intervention non autorisée, à l'usure normale ou à une utilisation contraire aux instructions du produit.",
                    ],
                    bullets: [],
                },
                {
                    title: "Retours, remboursements et droit applicable",
                    paragraphs: [
                        "La politique de retours et de remboursements de RecyTech est décrite dans la page dédiée. Sauf engagement commercial contraire de RecyTech, le droit suisse ne prévoit pas de droit général de révocation pour les achats en ligne.",
                        "Les présentes conditions sont soumises au droit suisse. Le for juridique impératif demeure réservé ; à défaut, les tribunaux compétents du canton de Neuchâtel sont compétents.",
                    ],
                    bullets: [],
                },
            ],
        },
        "remboursements-retours": {
            title: "Politique de remboursements et de retours",
            heading: "Politique de remboursements et de retours",
            intro: "Cette politique décrit les conditions commerciales appliquées par RecyTech en matière de retours, d'échanges et de remboursements.",
            sections: [
                {
                    title: "Aperçu",
                    paragraphs: [
                        "RecyTech propose à titre commercial une politique de retour de 30 jours à compter de la réception du produit, sous réserve des conditions ci-dessous.",
                        "Cette politique commerciale complète les droits légaux éventuellement applicables ; elle ne doit pas être comprise comme l'existence d'un droit général de révocation prévu automatiquement par le droit suisse pour tout achat en ligne.",
                    ],
                    bullets: [],
                },
                {
                    title: "Conditions de retour",
                    paragraphs: [
                        "Pour être éligible à un retour standard, l'article doit être restitué dans un état compatible avec une revente ou un contrôle technique raisonnable, avec ses accessoires essentiels et, si possible, son emballage d'origine.",
                        "Le client doit fournir une preuve d'achat ou le numero de commande correspondant.",
                    ],
                    bullets: [
                        "les articles endommagés après la livraison en raison d'une mauvaise utilisation peuvent être refusés",
                        "les retours annoncés après le délai commercial de 30 jours peuvent être refusés hors cas de garantie ou d'obligation légale",
                        "les produits explicitement exclus de reprise au moment de la vente ne sont pas repris, sauf défaut couvert",
                    ],
                },
                {
                    title: "Produits défectueux ou non conformes",
                    paragraphs: [
                        "Si le produit est défectueux, incomplet ou non conforme à la commande, le client doit contacter RecyTech sans délai avec une description du problème et, dans la mesure du possible, des photographies.",
                        "Dans ces cas, RecyTech examinera si une réparation, un remplacement, une réduction de prix ou un remboursement est approprié selon les circonstances et le droit applicable.",
                    ],
                    bullets: [],
                },
                {
                    title: "Frais de retour et remboursement",
                    paragraphs: [
                        "Sauf erreur de RecyTech ou produit défectueux reconnu, les frais de retour sont à la charge du client.",
                        "Une fois le retour reçu et contrôlé, RecyTech informe le client de l'acceptation ou du refus du remboursement. En cas d'acceptation, le remboursement est effectué sur le moyen de paiement approprié ou selon une autre modalité convenue.",
                        "Les frais d'expédition initiaux ne sont remboursés que si la loi l'impose ou si RecyTech en décide autrement dans le cas concret.",
                    ],
                    bullets: [],
                },
                {
                    title: "Échanges et contact",
                    paragraphs: [
                        "Les échanges sont traités au cas par cas selon la disponibilité du stock. Lorsqu'un produit identique n'est plus disponible, RecyTech peut proposer une alternative ou un remboursement.",
                        `Pour toute question relative à un retour, un remboursement ou une garantie, contactez RecyTech à ${supportEmail} ou à l'adresse ${supportAddress}.`,
                    ],
                    bullets: [],
                },
            ],
        },
    };
}

function normalizeOrigin(value) {
    return String(value || "").trim().replace(/\/$/, "");
}

function readUrlHost(value) {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return "";
    }
}

function isLocalHost(host) {
    return ["localhost", "127.0.0.1", "::1"].includes(String(host || "").toLowerCase());
}

function isLegacyShopHost(host) {
    return ["v2.shop.recytech.me"].includes(String(host || "").toLowerCase());
}

function requestOrigin(req) {
    const host = String(req.get("host") || "").trim();
    if (!host) {
        return "";
    }

    return `${req.protocol}://${host}`;
}

function baseUrl(req) {
    const configuredOrigin = normalizeOrigin(env.SHOP_PUBLIC_URL || env.BASE_URL);
    const currentRequestOrigin = normalizeOrigin(requestOrigin(req));
    const configuredHost = readUrlHost(configuredOrigin);
    const requestHost = readUrlHost(currentRequestOrigin);

    if (
        configuredOrigin &&
        currentRequestOrigin &&
        requestHost &&
        configuredHost !== requestHost &&
        !isLocalHost(requestHost) &&
        (isLocalHost(configuredHost) || isLegacyShopHost(configuredHost))
    ) {
        return currentRequestOrigin;
    }

    return configuredOrigin || currentRequestOrigin;
}

function getOrderDocumentConfig(req) {
    const publicBaseUrl = baseUrl(req).replace(/\/$/, "");

    return {
        termsUrl: String(env.TERMS_URL || "").trim() || (publicBaseUrl ? `${publicBaseUrl}/conditions-generales-de-vente` : ""),
        websiteUrl: String(env.PUBLIC_WEBSITE_URL || "").trim() || publicBaseUrl,
    };
}

function isSameSiteAssetUrl(value) {
    try {
        const url = new URL(value);
        return (
            ["shop.recytech.me", "v2.shop.recytech.me", "localhost", "127.0.0.1"].includes(url.hostname.toLowerCase()) &&
            url.pathname.startsWith("/static/")
        );
    } catch {
        return false;
    }
}

function absoluteUrl(req, value) {
    const input = String(value || "").trim();
    if (!input) {
        return "";
    }

    const origin = normalizeOrigin(baseUrl(req));

    if (/^https?:\/\//i.test(input)) {
        if (!isSameSiteAssetUrl(input)) {
            return input;
        }

        const url = new URL(input);
        return `${origin}${url.pathname}${url.search}`;
    }

    return `${origin}${input.startsWith("/") ? "" : "/"}${input}`;
}

function uploadUrl(file, folder) {
    if (!file?.filename) {
        return "";
    }

    return `/static/uploads/${folder}/${file.filename}`;
}

function productUploadUrl(file) {
    return uploadUrl(file, "products");
}

function settingsUploadUrl(file) {
    return uploadUrl(file, "settings");
}

function ensureUploadDirectory(req, res, directoryPath) {
    try {
        fs.mkdirSync(directoryPath, { recursive: true });
        return true;
    } catch (error) {
        setFlash(req, "error", `Préparation du dossier d'import impossible : ${error.message}`);
        saveSessionAndRedirect(req, res, req.get("referer") || req.originalUrl || "/admin");
        return false;
    }
}

function withProductUploads(req, res, next) {
    if (req.productUploadsParsed) {
        return next();
    }

    if (!ensureUploadDirectory(req, res, productUploadDir)) {
        return undefined;
    }

    productImageUpload.fields([
        { name: "image_file", maxCount: 1 },
        { name: "gallery_files", maxCount: 12 },
    ])(req, res, (error) => {
        if (error) {
            setFlash(req, "error", error.message || "L'import des images a échoué.");
            return saveSessionAndRedirect(req, res, req.get("referer") || req.originalUrl || "/admin/products/new");
        }

        req.productUploadsParsed = true;
        return next();
    });
}

function withSettingsUpload(req, res, next) {
    if (req.settingsUploadParsed) {
        return next();
    }

    if (!ensureUploadDirectory(req, res, settingsUploadDir)) {
        return undefined;
    }

    settingsImageUpload.single("hero_image_file")(req, res, (error) => {
        if (error) {
            setFlash(req, "error", error.message || "L'import de l'image a échoué.");
            return saveSessionAndRedirect(req, res, req.get("referer") || req.originalUrl || "/admin/settings");
        }

        req.settingsUploadParsed = true;
        return next();
    });
}

function isProductUploadRequest(req) {
    return req.method === "POST" && (
        req.path === "/admin/products/new" ||
        /^\/admin\/products\/\d+\/edit$/.test(req.path)
    ) && req.is("multipart/form-data");
}

function isSettingsUploadRequest(req) {
    return req.method === "POST" && req.path === "/admin/settings" && req.is("multipart/form-data");
}

function productInputWithUploads(req) {
    const input = { ...req.body };
    const primaryUpload = productUploadUrl(req.files?.image_file?.[0]);
    const galleryUploads = (req.files?.gallery_files || []).map(productUploadUrl).filter(Boolean);
    const existingGalleryUrls = String(input.image_gallery_urls || "").trim();

    if (primaryUpload) {
        input.image_url = primaryUpload;
    }

    if (!input.image_url && galleryUploads.length) {
        input.image_url = galleryUploads.shift();
    }

    if (galleryUploads.length) {
        input.image_gallery_urls = [existingGalleryUrls, ...galleryUploads]
            .filter(Boolean)
            .join("\n");
    }

    return input;
}

function setPublicApiHeaders(res) {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Cache-Control", "public, max-age=120");
}

function productCategoryList(product) {
    const categories = Array.isArray(product?.categories)
        ? product.categories.filter(Boolean)
        : [];

    return categories.length || !product?.category
        ? categories
        : [product.category];
}

function serializePublicProduct(req, product) {
    const images = (product.gallery_images || [])
        .map((src) => absoluteUrl(req, src))
        .filter(Boolean)
        .map((src, index) => ({
            id: `${product.id}-${index}`,
            src,
            alt: product.name,
            position: index,
        }));
    const displayPriceCents = product.starting_price_cents ?? product.price_cents;
    const categories = productCategoryList(product);

    return {
        id: product.id,
        slug: product.slug,
        name: product.name,
        short_description: product.short_description || "",
        description: product.description || "",
        price: ((displayPriceCents || 0) / 100).toFixed(2),
        regular_price: ((displayPriceCents || 0) / 100).toFixed(2),
        price_html: product.has_configuration_pricing ? formatProductPrice(product) : "",
        price_range: product.has_configuration_pricing
            ? {
                min_price: ((product.starting_price_cents || 0) / 100).toFixed(2),
                max_price: ((product.maximum_price_cents || 0) / 100).toFixed(2),
            }
            : null,
        currency: product.currency || "CHF",
        categories: categories.map((category) => ({
            id: category,
            name: category,
            slug: category.toLowerCase().replace(/\s+/g, "-"),
        })),
        featured: Boolean(product.featured),
        stock_quantity: Math.max(0, Number(product.inventory || 0)),
        stock_status: product.inventory > 0 ? "instock" : "outofstock",
        status: product.published ? "publish" : "draft",
        permalink: `${baseUrl(req).replace(/\/$/, "")}/products/${product.slug}`,
        images,
    };
}

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

function getProductUnitPriceCents(product, selectedOptions = []) {
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

function buildCart(req) {
    const rawItems = getCartItems(req);
    const items = [];

    for (const rawItem of rawItems) {
        const product = getProductById(db, rawItem.productId);
        if (!product || !product.published) {
            continue;
        }

        const quantity = product.inventory > 0 ? Math.min(Math.max(1, rawItem.quantity), product.inventory) : Math.max(1, rawItem.quantity);
        const selectedOptions = Array.isArray(rawItem.selectedOptions)
            ? rawItem.selectedOptions
                .map((option) => ({
                    name: normalizeText(option?.name),
                    value: normalizeText(option?.value),
                }))
                .filter((option) => option.name && option.value)
            : [];
        let unitPriceCents = product.price_cents;

        try {
            unitPriceCents = getProductUnitPriceCents(product, selectedOptions);
        } catch {
            continue;
        }

        items.push({
            product_id: product.id,
            item_key: rawItem.itemKey || `${product.id}:${JSON.stringify(selectedOptions)}`,
            slug: product.slug,
            name: product.name,
            category: product.category,
            categories: productCategoryList(product),
            short_description: product.short_description,
            image_url: product.image_url,
            selected_options: selectedOptions,
            quantity,
            unit_price_cents: unitPriceCents,
            line_total_cents: unitPriceCents * quantity,
            inventory: product.inventory,
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

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
    if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
        return res.status(204).end();
    }

    try {
        const signature = req.headers["stripe-signature"];
        const event = stripe.webhooks.constructEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET);

        if (event.type === "payment_intent.succeeded") {
            const paymentIntent = event.data.object;
            const order = getOrderByProviderReference(db, "stripe", paymentIntent.id);

            if (order) {
                markOrderPaid(db, order.id, {
                    stripePaymentIntentId: paymentIntent.id,
                    paymentStatus: paymentIntent.status,
                });
            }
        }

        if (["payment_intent.payment_failed", "payment_intent.canceled"].includes(event.type)) {
            const paymentIntent = event.data.object;
            const order = getOrderByProviderReference(db, "stripe", paymentIntent.id);

            if (order) {
                updateOrderStatus(db, order.id, "failed", {
                    stripePaymentIntentId: paymentIntent.id,
                    paymentStatus: paymentIntent.status,
                });
            }
        }

        res.status(200).json({ received: true });
    } catch (error) {
        res.status(400).send(`Webhook Error: ${error.message}`);
    }
});

app.post("/webhooks/swiss-bitcoin-pay", express.raw({ type: "application/json" }), (req, res) => {
    try {
        if (!verifySwissBitcoinPayWebhook(req)) {
            return res.status(401).json({ error: "Invalid webhook secret" });
        }

        const invoice = JSON.parse(req.body.toString("utf8") || "{}");
        const invoiceId = normalizeText(invoice.id || invoice.invoice?.id);

        if (!invoiceId) {
            return res.status(200).json({ received: true });
        }

        const order = getOrderByProviderReference(db, "swissbitcoinpay", invoiceId);
        if (!order) {
            return res.status(200).json({ received: true });
        }

        const nextStatus = mapSwissBitcoinPayStatus(invoice);
        const metadata = {
            swissBitcoinPayInvoiceId: invoiceId,
            invoiceStatus: invoice.status || "",
            paymentMethod: invoice.paymentMethod || "",
            txId: invoice.txId || "",
        };

        if (nextStatus === "paid") {
            markOrderPaid(db, order.id, metadata);
        } else {
            updateOrderStatus(db, order.id, nextStatus, metadata);
        }

        res.status(200).json({ received: true });
    } catch (error) {
        res.status(400).send(`Webhook Error: ${error.message}`);
    }
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
            secure: /^https:\/\//i.test(env.BASE_URL || "") ? "auto" : false,
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

app.options(["/api/products", "/wp-json/wc/v3/products"], (req, res) => {
    setPublicApiHeaders(res);
    res.status(204).end();
});

app.get(["/api/products", "/wp-json/wc/v3/products"], (req, res) => {
    setPublicApiHeaders(res);
    res.json(listPublishedProducts(db).map((product) => serializePublicProduct(req, product)));
});

app.post("/checkout/session", (req, res) => {
    setCheckoutForm(req, buildCheckoutDraft(req.body || {}, getCheckoutForm(req)));
    req.session.save(() => {
        res.status(204).end();
    });
});

app.post("/checkout/promo", (req, res) => {
    const cart = buildCart(req);
    if (!cart.items.length) {
        setFlash(req, "error", "Votre panier est vide.");
        return saveSessionAndRedirect(req, res, "/cart");
    }

    const nextForm = buildCheckoutDraft(req.body || {}, getCheckoutForm(req));
    setCheckoutForm(req, nextForm);
    clearStripeDraft(req);

    const promoCodeOutcome = getPromoCodeOutcome(nextForm.promo_code, cart.subtotalCents);
    if (!nextForm.promo_code) {
        setFlash(req, "success", "Le code promo a été retiré.");
        return saveSessionAndRedirect(req, res, "/checkout");
    }

    if (promoCodeOutcome.error) {
        setFlash(req, "error", promoCodeOutcome.error);
        return saveSessionAndRedirect(req, res, "/checkout");
    }

    setFlash(req, "success", `${promoCodeOutcome.promoCode.code} a bien été appliqué.`);
    return saveSessionAndRedirect(req, res, "/checkout");
});

app.post("/checkout/stripe/intent", async (req, res) => {
    try {
        const draft = await createOrReuseStripeIntent(req, req.body || {});
        req.session.save(() => {
            res.json({
                paymentIntentId: draft.paymentIntentId,
                clientSecret: draft.clientSecret,
            });
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post("/checkout/stripe/prepare", async (req, res) => {
    try {
        if (!paymentState().stripeEnabled) {
            return res.status(400).json({ error: "Le paiement par carte est indisponible." });
        }

        const paymentIntentId = normalizeText(req.body.stripe_payment_intent_id);
        if (!paymentIntentId) {
            return res.status(400).json({ error: "Session de paiement Stripe manquante." });
        }

        const checkoutDetails = validateCheckoutInput(req.body || {});
        checkoutDetails.form.payment_method = "card";
        setCheckoutForm(req, checkoutDetails.form);

        const cart = buildCart(req);
        if (!cart.items.length) {
            return res.status(400).json({ error: "Le panier est vide." });
        }

        const promoCodeOutcome = requirePromoCodeOutcome(checkoutDetails.form.promo_code, cart.subtotalCents);
        const pricing = getCheckoutPricing(cart.subtotalCents, checkoutDetails.shippingOption, "card", promoCodeOutcome);
        const amountCents = pricing.totalCents;
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (paymentIntent.currency !== "chf" || paymentIntent.amount !== amountCents) {
            return res.status(400).json({ error: "Le montant Stripe ne correspond plus à la commande." });
        }

        let order = getOrderByProviderReference(db, "stripe", paymentIntent.id);
        let createdOrder = false;
        if (!order) {
            order = createOrder(db, {
                provider: "stripe",
                provider_reference: paymentIntent.id,
                customer_name: checkoutDetails.customer.name,
                customer_email: checkoutDetails.customer.email,
                amount_cents: amountCents,
                currency: "CHF",
                items: cart.items,
                status: "pending",
                metadata: {
                    checkout: checkoutDetails.form,
                    delivery: {
                        method: checkoutDetails.shippingOption.key,
                        label: checkoutDetails.shippingOption.label,
                        amount_cents: checkoutDetails.shippingOption.priceCents,
                    },
                    additions: [
                        ...(checkoutDetails.shippingOption.priceCents > 0
                        ? [{
                            type: "shipping",
                            label: checkoutDetails.shippingOption.label,
                            amount_cents: checkoutDetails.shippingOption.priceCents,
                        }]
                        : []),
                        ...pricing.discountLines,
                    ],
                    promo: promoCodeOutcome.promoCode
                        ? {
                            id: promoCodeOutcome.promoCode.id,
                            code: promoCodeOutcome.promoCode.code,
                            description: promoCodeOutcome.promoCode.description,
                            discount_type: promoCodeOutcome.promoCode.discount_type,
                            discount_value: promoCodeOutcome.promoCode.discount_value,
                            discount_cents: promoCodeOutcome.discountCents,
                            label: promoCodeOutcome.label,
                        }
                        : null,
                    stripePaymentIntentId: paymentIntent.id,
                },
            });
            createdOrder = true;
        }

        if (createdOrder) {
            await notifyNewOrder(order);
        }

        await stripe.paymentIntents.update(paymentIntent.id, {
            receipt_email: checkoutDetails.customer.email,
            metadata: {
                source: "recytech-shop",
                order_number: order.order_number,
                delivery_method: checkoutDetails.shippingOption.key,
                promo_code: promoCodeOutcome.code || "",
            },
        });

        req.session.save(() => {
            res.json({
                successUrl: `/checkout/success?provider=stripe&payment_intent=${encodeURIComponent(paymentIntent.id)}&order=${encodeURIComponent(order.order_number)}&view=${encodeURIComponent(createOrderViewToken(order))}`,
                orderNumber: order.order_number,
            });
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

function readCatalogueFilters(values) {
    const priceMin = normalizeText(values.price_min);
    const priceMax = normalizeText(values.price_max);
    const minPriceCents = parseMoneyToCents(priceMin, Number.NaN);
    const maxPriceCents = parseMoneyToCents(priceMax, Number.NaN);
    const availability = normalizeText(values.availability);
    const sort = normalizeText(values.sort) || "random";
    const allowedAvailability = new Set(["", "in_stock", "out_of_stock"]);
    const allowedSorts = new Set(["random", "featured", "newest", "price_asc", "price_desc", "name_asc"]);

    const view = {
        q: normalizeText(values.q),
        category: normalizeText(values.category),
        price_min: priceMin,
        price_max: priceMax,
        availability: allowedAvailability.has(availability) ? availability : "",
        sort: allowedSorts.has(sort) ? sort : "random",
    };

    return {
        view,
        productFilters: {
            query: view.q,
            category: view.category,
            minPriceCents: Number.isFinite(minPriceCents) ? minPriceCents : null,
            maxPriceCents: Number.isFinite(maxPriceCents) ? maxPriceCents : null,
            availability: view.availability,
            sort: view.sort,
        },
        hasActiveFilters: Boolean(
            view.q ||
            view.category ||
            view.price_min ||
            view.price_max ||
            view.availability ||
            view.sort !== "random"
        ),
    };
}

app.get("/", (req, res) => {
    const catalogue = readCatalogueFilters(req.query);

    render(res, "home", {
        title: "Boutique RecyTech",
        products: listPublishedProducts(db, catalogue.productFilters),
        catalogueFilters: catalogue.view,
        catalogueCategories: listProductCategories(db, { publishedOnly: true }),
        hasCatalogueFilters: catalogue.hasActiveFilters,
    });
});

app.get(["/politique-confidentialite", "/conditions-generales-de-vente", "/remboursements-retours"], (req, res) => {
    const slug = req.path.replace(/^\//, "");
    const page = getLegalPages(res.locals.settings)[slug];

    render(res, "legal", {
        title: page.title,
        page,
    });
});

app.get("/products/:slug", (req, res) => {
    const product = getProductBySlug(db, req.params.slug);
    if (!product || !product.published) {
        return res.status(404).render("not-found", { title: "Produit introuvable" });
    }

    render(res, "product", {
        title: product.name,
        product,
    });
});

app.post("/cart/add", (req, res) => {
    const productId = Number.parseInt(req.body.product_id, 10);
    const quantity = Number.parseInt(req.body.quantity || "1", 10) || 1;
    const product = getProductById(db, productId);

    if (!product || !product.published) {
        setFlash(req, "error", "Produit introuvable.");
        return saveSessionAndRedirect(req, res, "/");
    }

    const redirectTarget = getSafeRedirectTarget(req.body.redirect_to, `/products/${product.slug}`);

    if (product.inventory <= 0) {
        setFlash(req, "error", "Ce produit est en rupture de stock.");
        return saveSessionAndRedirect(req, res, redirectTarget);
    }

    let selectedOptions = [];

    try {
        selectedOptions = readSelectedProductOptions(product, req.body);
    } catch (error) {
        setFlash(req, "error", error.message);
        return saveSessionAndRedirect(req, res, redirectTarget);
    }

    upsertCartItem(req, productId, Math.min(quantity, product.inventory), selectedOptions);
    setFlash(req, "success", `${product.name} a été ajouté au panier.`, {
        actionHref: "/cart",
        actionLabel: "Voir le panier",
    });
    saveSessionAndRedirect(req, res, redirectTarget);
});

app.get("/cart", (req, res) => {
    render(res, "cart", {
        title: "Panier",
    });
});

app.post("/cart/update", (req, res) => {
    const itemKey = normalizeText(req.body.item_key);
    const productId = Number.parseInt(req.body.product_id, 10);
    const quantity = Number.parseInt(req.body.quantity || "1", 10) || 1;
    const product = getProductById(db, productId);
    const cartItem = getCartItems(req).find((item) => (item.itemKey || makeCartItemKey(item.productId, item.selectedOptions || [])) === itemKey);

    if (!product || product.inventory <= 0) {
        if (itemKey) {
            removeCartItem(req, itemKey);
        }
        setFlash(req, "error", "Ce produit n'est plus disponible.");
        return saveSessionAndRedirect(req, res, "/cart");
    }

    upsertCartItem(req, productId, Math.min(quantity, product.inventory), cartItem?.selectedOptions || []);
    setFlash(req, "success", "Le panier a été mis à jour.");
    saveSessionAndRedirect(req, res, "/cart");
});

app.post("/cart/remove", (req, res) => {
    const itemKey = normalizeText(req.body.item_key);
    if (itemKey) {
        removeCartItem(req, itemKey);
    }
    setFlash(req, "success", "Le produit a été retiré du panier.");
    saveSessionAndRedirect(req, res, "/cart");
});

app.get("/checkout", (req, res) => {
    if (!res.locals.cart.items.length) {
        setFlash(req, "error", "Votre panier est vide.");
        return res.redirect("/cart");
    }

    const checkoutForm = getCheckoutForm(req);
    const shippingOption = SHIPPING_OPTIONS[checkoutForm.delivery_method] || SHIPPING_OPTIONS.pickup;
    const promoCodeOutcome = getPromoCodeOutcome(checkoutForm.promo_code, res.locals.cart.subtotalCents);
    const pricing = getCheckoutPricing(res.locals.cart.subtotalCents, shippingOption, checkoutForm.payment_method, promoCodeOutcome.error ? null : promoCodeOutcome);

    render(res, "checkout", {
        title: "Paiement",
        checkoutForm,
        pricing,
        promoCodeOutcome,
        shippingOptions: SHIPPING_OPTIONS,
        shippingCostCents: shippingOption.priceCents,
        orderTotalCents: pricing.totalCents,
    });
});

function createOrderFromSessionCart(req, provider, customer, checkoutDetails) {
    const cart = buildCart(req);
    if (!cart.items.length) {
        throw new Error("Le panier est vide.");
    }

    const promoCodeOutcome = requirePromoCodeOutcome(checkoutDetails.form.promo_code, cart.subtotalCents);
    const pricing = getCheckoutPricing(
        cart.subtotalCents,
        checkoutDetails.shippingOption,
        checkoutDetails.form.payment_method,
        promoCodeOutcome
    );
    const shippingLine = checkoutDetails.shippingOption.priceCents > 0
        ? [{
            type: "shipping",
            label: checkoutDetails.shippingOption.label,
            amount_cents: checkoutDetails.shippingOption.priceCents,
        }]
        : [];

    return createOrder(db, {
        provider,
        customer_name: customer.name,
        customer_email: customer.email,
        amount_cents: pricing.totalCents,
        currency: "CHF",
        items: cart.items,
        status: provider === "transfer" ? "awaiting_transfer" : "pending",
        metadata: {
            checkout: checkoutDetails.form,
            delivery: {
                method: checkoutDetails.shippingOption.key,
                label: checkoutDetails.shippingOption.label,
                amount_cents: checkoutDetails.shippingOption.priceCents,
            },
            additions: [...shippingLine, ...pricing.discountLines],
            promo: promoCodeOutcome.promoCode
                ? {
                    id: promoCodeOutcome.promoCode.id,
                    code: promoCodeOutcome.promoCode.code,
                    description: promoCodeOutcome.promoCode.description,
                    discount_type: promoCodeOutcome.promoCode.discount_type,
                    discount_value: promoCodeOutcome.promoCode.discount_value,
                    discount_cents: promoCodeOutcome.discountCents,
                    label: promoCodeOutcome.label,
                }
                : null,
        },
    });
}

function readManualOrderInput(values) {
    const productId = Number.parseInt(values.product_id, 10);
    const quantity = Math.max(1, Number.parseInt(values.quantity || "1", 10) || 1);
    const customerName = normalizeSingleLineText(values.customer_name);
    const customerEmail = normalizeSingleLineText(values.customer_email);
    const customerPhone = normalizeSingleLineText(values.customer_phone);
    const paymentLabel = normalizeSingleLineText(values.payment_label) || "Vente hors site";
    const status = normalizeText(values.status) || "paid";
    const internalNote = normalizeText(values.internal_note);
    const priceOverrideRaw = String(values.unit_price_chf || "").trim();
    const unitPriceOverrideCents = priceOverrideRaw ? parseMoneyToCents(priceOverrideRaw, Number.NaN) : null;
    const discountRaw = String(values.discount_chf || "").trim();
    const discountCents = discountRaw ? parseMoneyToCents(discountRaw, Number.NaN) : 0;
    const createdAt = normalizeOrderDateTimeField(values.order_created_at, new Date().toISOString());
    const promoCode = normalizePromoCode(values.promo_code);

    if (!customerName) {
        throw new Error("Le nom du client est obligatoire.");
    }

    if (!Number.isInteger(productId) || productId <= 0) {
        throw new Error("Produit invalide.");
    }

    if (!ORDER_STATUS_OPTIONS.some((option) => option.value === status)) {
        throw new Error("Statut de commande invalide.");
    }

    if (unitPriceOverrideCents !== null && (!Number.isFinite(unitPriceOverrideCents) || unitPriceOverrideCents < 0)) {
        throw new Error("Prix unitaire invalide.");
    }

    if (!Number.isFinite(discountCents) || discountCents < 0) {
        throw new Error("Remise invalide.");
    }

    return {
        productId,
        quantity,
        customerName,
        customerEmail,
        customerPhone,
        paymentLabel,
        status,
        internalNote,
        unitPriceOverrideCents,
        createdAt,
        discountCents,
        promoCode,
    };
}

function buildManualOrderDiscount(input, subtotalCents) {
    const manualDiscountCents = input.discountCents || 0;
    const promoOutcome = input.promoCode ? getPromoCodeOutcome(input.promoCode, subtotalCents) : null;

    if (manualDiscountCents > subtotalCents) {
        throw new Error("La remise ne peut pas dépasser le total des articles.");
    }

    if (promoOutcome?.error && manualDiscountCents <= 0) {
        throw new Error(promoOutcome.error);
    }

    const discountCents = manualDiscountCents > 0
        ? manualDiscountCents
        : promoOutcome?.discountCents || 0;
    const promoCode = promoOutcome?.code || input.promoCode || "";
    const validPromoCode = promoOutcome && !promoOutcome.error ? promoOutcome.promoCode : null;
    const label = promoCode
        ? getPromoCodeLabel({ code: promoCode })
        : "Remise manuelle";

    return {
        discountCents,
        discountLine: discountCents > 0
            ? {
                type: "discount",
                code: promoCode,
                label,
                amount_cents: -discountCents,
            }
            : null,
        promo: promoCode
            ? {
                id: validPromoCode?.id || null,
                code: promoCode,
                description: validPromoCode?.description || "",
                discount_type: validPromoCode?.discount_type || (manualDiscountCents > 0 ? "manual" : ""),
                discount_value: validPromoCode?.discount_value || discountCents,
                discount_cents: discountCents,
                label,
                manual_override: manualDiscountCents > 0,
            }
            : null,
    };
}

function buildManualOrderItem(product, input) {
    const selectedOptions = Array.isArray(input.selectedOptions) ? input.selectedOptions : [];
    const unitPriceCents = input.unitPriceOverrideCents ?? getProductUnitPriceCents(product, selectedOptions);

    return {
        product_id: product.id,
        item_key: `manual:${product.id}:${JSON.stringify(selectedOptions)}:${Date.now()}`,
        slug: product.slug,
        name: product.name,
        category: product.category,
        categories: productCategoryList(product),
        short_description: product.short_description,
        image_url: product.image_url,
        selected_options: selectedOptions,
        quantity: input.quantity,
        unit_price_cents: unitPriceCents,
        line_total_cents: unitPriceCents * input.quantity,
        inventory: product.inventory,
    };
}

function finalizeManualOrderStatus(order, targetStatus, metadata) {
    const stockReducingStatuses = new Set(["paid", "processing", "ready_for_pickup", "shipped", "completed"]);

    if (!stockReducingStatuses.has(targetStatus)) {
        return updateOrderRecord(db, order.id, {
            status: targetStatus,
            metadata,
        });
    }

    const paidOrder = markOrderPaid(db, order.id, metadata);
    if (targetStatus === "paid") {
        return paidOrder;
    }

    return updateOrderRecord(db, paidOrder.id, {
        status: targetStatus,
    });
}

async function notifyNewOrder(order) {
    try {
        await sendNewOrderNotification(order);
    } catch (error) {
        console.error(`Order notification email failed for ${order.order_number}: ${error.message}`);
    }
}

app.post("/checkout", async (req, res) => {
    try {
        const checkoutDetails = validateCheckout(req);
        setCheckoutForm(req, checkoutDetails.form);

        if (checkoutDetails.form.payment_method === "card") {
            if (!paymentState().stripeEnabled) {
                setFlash(req, "error", "Le paiement par carte est indisponible.");
                return saveSessionAndRedirect(req, res, "/checkout");
            }

            setFlash(req, "error", "Le paiement par carte se finalise directement sur cette page.");
            return saveSessionAndRedirect(req, res, "/checkout");
        }

        if (checkoutDetails.form.payment_method === "bitcoin") {
            if (!paymentState().bitcoinEnabled) {
                setFlash(req, "error", "Le paiement bitcoin est indisponible.");
                return saveSessionAndRedirect(req, res, "/checkout");
            }

            const order = createOrderFromSessionCart(req, "swissbitcoinpay", checkoutDetails.customer, checkoutDetails);
            await notifyNewOrder(order);
            const invoice = await createSwissBitcoinPayInvoice(order, req);

            updateOrderProviderReference(db, order.id, invoice.id, {
                checkoutUrl: invoice.checkoutUrl || "",
                lightningInvoice: invoice.pr || "",
                onChainAddress: invoice.onChainAddr || "",
            });

            return saveSessionAndRedirect(req, res, invoice.checkoutUrl);
        }

        if (checkoutDetails.form.payment_method === "cash") {
            const cashOrder = createOrderFromSessionCart(req, "cash", checkoutDetails.customer, checkoutDetails);
            await notifyNewOrder(cashOrder);
            clearCheckoutForm(req);
            setCartItems(req, []);
            return saveSessionAndRedirect(req, res, `/checkout/success?provider=cash&order=${encodeURIComponent(cashOrder.order_number)}&view=${encodeURIComponent(createOrderViewToken(cashOrder))}`);
        }

        const transferOrder = createOrderFromSessionCart(req, "transfer", checkoutDetails.customer, checkoutDetails);
        await notifyNewOrder(transferOrder);
        clearCheckoutForm(req);
        setCartItems(req, []);
        return saveSessionAndRedirect(req, res, `/checkout/success?provider=transfer&order=${encodeURIComponent(transferOrder.order_number)}&view=${encodeURIComponent(createOrderViewToken(transferOrder))}`);
    } catch (error) {
        setFlash(req, "error", error.message);
        return saveSessionAndRedirect(req, res, "/checkout");
    }
});

app.get("/checkout/success", async (req, res) => {
    let order = null;
    let visibleOrder = null;

    try {
        if (req.query.provider === "stripe" && req.query.payment_intent && stripe) {
            const paymentIntent = await stripe.paymentIntents.retrieve(req.query.payment_intent);
            order = getOrderByProviderReference(db, "stripe", paymentIntent.id);

            if (order && paymentIntent.status === "succeeded") {
                order = markOrderPaid(db, order.id, {
                    stripePaymentIntentId: paymentIntent.id,
                    paymentStatus: paymentIntent.status,
                });
                setCartItems(req, []);
            } else if (order && ["processing", "requires_capture"].includes(paymentIntent.status)) {
                order = updateOrderStatus(db, order.id, "pending", {
                    stripePaymentIntentId: paymentIntent.id,
                    paymentStatus: paymentIntent.status,
                });
            }

            if (order && verifyOrderViewToken(order, req.query.view)) {
                visibleOrder = order;
            }
        }

        if (req.query.provider === "swissbitcoinpay" && req.query.order) {
            order = getOrderByNumber(db, req.query.order);

            if (order && verifyOrderViewToken(order, req.query.view)) {
                visibleOrder = order;
            }

            if (visibleOrder?.provider_reference && paymentState().bitcoinEnabled) {
                const invoice = await fetchSwissBitcoinPayInvoice(order.provider_reference);
                const nextStatus = mapSwissBitcoinPayStatus(invoice);
                const metadata = {
                    swissBitcoinPayInvoiceId: invoice.id,
                    invoiceStatus: invoice.status || "",
                    paymentMethod: invoice.paymentMethod || "",
                    txId: invoice.txId || "",
                };

                if (nextStatus === "paid") {
                    order = markOrderPaid(db, order.id, metadata);
                    visibleOrder = order;
                    setCartItems(req, []);
                } else {
                    order = updateOrderStatus(db, order.id, nextStatus, metadata);
                    visibleOrder = order;
                }
            }
        }

        if (req.query.provider === "transfer" && req.query.order) {
            order = getOrderByNumber(db, req.query.order);
            if (order && verifyOrderViewToken(order, req.query.view)) {
                visibleOrder = order;
                setCartItems(req, []);
            }
        }

        if (req.query.provider === "cash" && req.query.order) {
            order = getOrderByNumber(db, req.query.order);
            if (order && verifyOrderViewToken(order, req.query.view)) {
                visibleOrder = order;
                setCartItems(req, []);
            }
        }
    } catch (error) {
        setFlash(req, "error", `Paiement terminé avec un statut incertain : ${error.message}`);
    }

    clearCheckoutForm(req);
    clearStripeDraft(req);

    render(res, "success", {
        title: "Commande",
        order: visibleOrder,
    });
});

app.get("/checkout/cancel", (req, res) => {
    render(res, "cancel", {
        title: "Paiement annulé",
        order: req.query.order ? getOrderByNumber(db, req.query.order) : null,
    });
});

app.get("/admin/login", (req, res) => {
    if (req.session.adminId) {
        return res.redirect("/");
    }

    render(res, "admin/login", {
        title: "Connexion",
    });
});

app.post("/admin/login", (req, res) => {
    const rateLimitState = getLoginRateLimitState(req);
    if (rateLimitState.blockedUntil > Date.now()) {
        setFlash(req, "error", "Trop de tentatives de connexion. Réessayez plus tard.");
        return saveSessionAndRedirect(req, res, "/admin/login");
    }

    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const admin = getAdminByUsername(db, username);

    if (!admin || !verifyPassword(password, admin.password_hash)) {
        registerLoginFailure(req);
        setFlash(req, "error", "Identifiants invalides.");
        return saveSessionAndRedirect(req, res, "/admin/login");
    }

    clearLoginFailures(req);
    req.session.regenerate((error) => {
        if (error) {
            setFlash(req, "error", "Impossible d'ouvrir une session sécurisée.");
            return saveSessionAndRedirect(req, res, "/admin/login");
        }

        req.session.adminId = admin.id;
        getOrCreateCsrfToken(req);
        setFlash(req, "success", "Connexion réussie.");
        return saveSessionAndRedirect(req, res, "/");
    });
});

app.post("/admin/logout", requireAdmin, (req, res) => {
    req.session.destroy(() => {
        res.clearCookie("connect.sid");
        res.redirect("/admin/login");
    });
});

app.get("/admin", requireAdmin, (req, res) => {
    render(res, "admin/dashboard", {
        title: "Administration",
        stats: getDashboardStats(db),
        products: listAdminProducts(db),
        recentOrders: listRecentOrders(db),
    });
});

app.get("/admin/account", requireAdmin, (req, res) => {
    render(res, "admin/account", {
        title: "Mon compte",
    });
});

app.post("/admin/account", requireAdmin, (req, res) => {
    const adminRecord = getAdminByUsername(db, req.currentAdmin.username);
    if (!adminRecord) {
        req.session.adminId = null;
        setFlash(req, "error", "Session administrateur invalide.");
        return saveSessionAndRedirect(req, res, "/admin/login");
    }

    try {
        const input = readAdminAccountInput(req.body, adminRecord);

        if ((input.usernameChanged || input.passwordChanged) && !verifyPassword(input.currentPassword, adminRecord.password_hash)) {
            throw new Error("Le mot de passe actuel est incorrect.");
        }

        updateAdminUser(db, adminRecord.id, {
            username: input.username,
            role: adminRecord.role,
            password: input.password,
        });

        setFlash(req, "success", "Votre compte a été mis à jour.");
        return saveSessionAndRedirect(req, res, "/admin/account");
    } catch (error) {
        const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
            ? "Ce nom d'utilisateur existe déjà."
            : error.message;
        setFlash(req, "error", message);
        return saveSessionAndRedirect(req, res, "/admin/account");
    }
});

app.get("/admin/admins", requireSuperadmin, (req, res) => {
    render(res, "admin/admins", {
        title: "Administrateurs",
        admins: listAdmins(db),
        superadminCount: countAdminsByRole(db, "superadmin"),
    });
});

app.get("/admin/admins/new", requireSuperadmin, (req, res) => {
    render(res, "admin/admin-form", {
        title: "Nouvel administrateur",
        formAction: "/admin/admins/new",
        adminUser: null,
        roleOptions: ADMIN_ROLE_OPTIONS,
        currentAdminId: req.currentAdmin.id,
    });
});

app.post("/admin/admins/new", requireSuperadmin, (req, res) => {
    try {
        const input = readAdminUserInput(req.body, { requirePassword: true });
        createAdminUser(db, input);
        setFlash(req, "success", "Administrateur créé.");
        return saveSessionAndRedirect(req, res, "/admin/admins");
    } catch (error) {
        const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
            ? "Ce nom d'utilisateur existe déjà."
            : error.message;
        setFlash(req, "error", message);
        return saveSessionAndRedirect(req, res, "/admin/admins/new");
    }
});

app.get("/admin/admins/:id/edit", requireSuperadmin, (req, res) => {
    const adminUser = getAdminById(db, Number.parseInt(req.params.id, 10));
    if (!adminUser) {
        return res.status(404).render("not-found", { title: "Administrateur introuvable" });
    }

    render(res, "admin/admin-form", {
        title: `Modifier ${adminUser.username}`,
        formAction: `/admin/admins/${adminUser.id}/edit`,
        adminUser,
        roleOptions: ADMIN_ROLE_OPTIONS,
        currentAdminId: req.currentAdmin.id,
    });
});

app.post("/admin/admins/:id/edit", requireSuperadmin, (req, res) => {
    const adminId = Number.parseInt(req.params.id, 10);
    const existingAdmin = getAdminById(db, adminId);
    if (!existingAdmin) {
        return res.status(404).render("not-found", { title: "Administrateur introuvable" });
    }

    try {
        const input = readAdminUserInput(req.body);
        if (existingAdmin.role === "superadmin" && input.role !== "superadmin" && countAdminsByRole(db, "superadmin") <= 1) {
            throw new Error("Le dernier superadmin ne peut pas être rétrogradé.");
        }

        updateAdminUser(db, adminId, input);
        setFlash(req, "success", "Administrateur mis à jour.");
        return saveSessionAndRedirect(req, res, "/admin/admins");
    } catch (error) {
        const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
            ? "Ce nom d'utilisateur existe déjà."
            : error.message;
        setFlash(req, "error", message);
        return saveSessionAndRedirect(req, res, `/admin/admins/${adminId}/edit`);
    }
});

app.post("/admin/admins/:id/delete", requireSuperadmin, (req, res) => {
    const adminId = Number.parseInt(req.params.id, 10);
    const adminUser = getAdminById(db, adminId);
    if (!adminUser) {
        return res.status(404).render("not-found", { title: "Administrateur introuvable" });
    }

    if (adminUser.id === req.currentAdmin.id) {
        setFlash(req, "error", "Vous ne pouvez pas supprimer votre propre compte.");
        return saveSessionAndRedirect(req, res, "/admin/admins");
    }

    if (adminUser.role === "superadmin" && countAdminsByRole(db, "superadmin") <= 1) {
        setFlash(req, "error", "Le dernier superadmin ne peut pas être supprimé.");
        return saveSessionAndRedirect(req, res, "/admin/admins");
    }

    deleteAdminUser(db, adminId);
    setFlash(req, "success", "Administrateur supprimé.");
    return saveSessionAndRedirect(req, res, "/admin/admins");
});

app.get("/admin/promo-codes", requireAdmin, (req, res) => {
    render(res, "admin/promo-codes", {
        title: "Codes promo",
        promoCodes: listPromoCodes(db),
    });
});

app.get("/admin/promo-codes/new", requireAdmin, (req, res) => {
    render(res, "admin/promo-code-form", {
        title: "Nouveau code promo",
        formAction: "/admin/promo-codes/new",
        promoCode: null,
    });
});

app.post("/admin/promo-codes/new", requireAdmin, (req, res) => {
    try {
        const input = readPromoCodeInput(req.body);
        createPromoCodeRecord(db, input);
        setFlash(req, "success", "Code promo créé.");
        return saveSessionAndRedirect(req, res, "/admin/promo-codes");
    } catch (error) {
        const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
            ? "Ce code promo existe déjà."
            : error.message;
        setFlash(req, "error", message);
        return saveSessionAndRedirect(req, res, "/admin/promo-codes/new");
    }
});

app.get("/admin/promo-codes/:id/edit", requireAdmin, (req, res) => {
    const promoCode = getPromoCodeById(db, Number.parseInt(req.params.id, 10));
    if (!promoCode) {
        return res.status(404).render("not-found", { title: "Code promo introuvable" });
    }

    render(res, "admin/promo-code-form", {
        title: `Modifier ${promoCode.code}`,
        formAction: `/admin/promo-codes/${promoCode.id}/edit`,
        promoCode,
    });
});

app.post("/admin/promo-codes/:id/edit", requireAdmin, (req, res) => {
    const promoCodeId = Number.parseInt(req.params.id, 10);

    try {
        const input = readPromoCodeInput(req.body);
        const promoCode = updatePromoCodeRecord(db, promoCodeId, input);

        if (!promoCode) {
            return res.status(404).render("not-found", { title: "Code promo introuvable" });
        }

        setFlash(req, "success", "Code promo mis à jour.");
        return saveSessionAndRedirect(req, res, "/admin/promo-codes");
    } catch (error) {
        const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
            ? "Ce code promo existe déjà."
            : error.message;
        setFlash(req, "error", message);
        return saveSessionAndRedirect(req, res, `/admin/promo-codes/${promoCodeId}/edit`);
    }
});

app.post("/admin/promo-codes/:id/delete", requireAdmin, (req, res) => {
    const promoCodeId = Number.parseInt(req.params.id, 10);
    const promoCode = getPromoCodeById(db, promoCodeId);

    if (!promoCode) {
        setFlash(req, "error", "Code promo introuvable.");
        return saveSessionAndRedirect(req, res, "/admin/promo-codes");
    }

    deletePromoCodeRecord(db, promoCodeId);
    setFlash(req, "success", `Le code promo ${promoCode.code} a été supprimé.`);
    return saveSessionAndRedirect(req, res, "/admin/promo-codes");
});

app.get("/admin/orders", requireAdmin, (req, res) => {
    const status = normalizeText(req.query.status);
    const query = normalizeText(req.query.q);

    render(res, "admin/orders", {
        title: "Commandes",
        orders: listOrders(db, {
            status: status || null,
            query: query || null,
        }),
        filters: {
            status,
            query,
        },
        orderStatusOptions: ORDER_STATUS_OPTIONS,
    });
});

app.get("/admin/orders/new", requireAdmin, (req, res) => {
    render(res, "admin/order-form", {
        title: "Nouvelle commande",
        products: listAdminProducts(db),
        promoCodes: listPromoCodes(db),
        orderStatusOptions: ORDER_STATUS_OPTIONS,
    });
});

app.post("/admin/orders/new", requireAdmin, (req, res) => {
    try {
        const input = readManualOrderInput(req.body);
        const product = getProductById(db, input.productId);

        if (!product) {
            throw new Error("Produit introuvable.");
        }

        if (product.inventory <= 0) {
            throw new Error("Ce produit est en rupture de stock.");
        }

        if (input.quantity > product.inventory) {
            throw new Error(`Stock insuffisant : ${product.inventory} unité(s) disponible(s).`);
        }

        const selectedOptions = readSelectedProductOptions(product, req.body);
        const item = buildManualOrderItem(product, { ...input, selectedOptions });
        const discount = buildManualOrderDiscount(input, item.line_total_cents);
        const amountCents = Math.max(0, item.line_total_cents - discount.discountCents);
        const metadata = {
            checkout: {
                customer_first_name: input.customerName,
                shipping_phone: input.customerPhone,
            },
            delivery: {
                method: "manual",
                label: "Vente hors site",
                amount_cents: 0,
            },
            additions: discount.discountLine ? [discount.discountLine] : [],
            promo: discount.promo,
            manual: {
                created_by_admin_id: req.currentAdmin?.id || null,
                created_by_admin_username: req.currentAdmin?.username || "",
                payment_label: input.paymentLabel,
                discount_cents: discount.discountCents,
            },
            admin: {
                internal_note: input.internalNote,
                customer_note: "",
                fulfillment_note: "",
                carrier: "",
                tracking_number: "",
                pickup_details: "",
            },
        };

        const order = createOrder(db, {
            provider: "manual",
            provider_reference: null,
            customer_name: input.customerName,
            customer_email: input.customerEmail,
            amount_cents: amountCents,
            currency: product.currency || "CHF",
            items: [item],
            status: "pending",
            metadata,
            created_at: input.createdAt,
        });
        const finalizedOrder = finalizeManualOrderStatus(order, input.status, metadata);

        setFlash(req, "success", `Commande ${finalizedOrder.order_number} créée.`);
        return saveSessionAndRedirect(req, res, `/admin/orders/${finalizedOrder.id}`);
    } catch (error) {
        setFlash(req, "error", error.message);
        return saveSessionAndRedirect(req, res, "/admin/orders/new");
    }
});

function sendOrderDocumentPdf(req, res, type) {
    const order = getOrderById(db, Number.parseInt(req.params.id, 10));
    if (!order) {
        return res.status(404).render("not-found", { title: "Commande introuvable" });
    }

    const pdf = buildOrderDocumentPdf({
        type,
        order,
        settings: res.locals.settings || getSettings(db),
        contact: getOrderContactSnapshot(order),
        admin: getOrderAdminData(order),
        getOrderStatusLabel,
        getOrderProviderLabel,
        baseUrl: baseUrl(req),
        config: getOrderDocumentConfig(req),
    });
    const filename = buildOrderDocumentFilename(order, type);

    res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "Content-Length": String(pdf.length),
    });

    return res.send(pdf);
}

app.get("/admin/orders/:id/invoice.pdf", requireAdmin, (req, res) => {
    return sendOrderDocumentPdf(req, res, "invoice");
});

app.get("/admin/orders/:id/delivery-slip.pdf", requireAdmin, (req, res) => {
    return sendOrderDocumentPdf(req, res, "delivery-slip");
});

app.get("/admin/orders/:id", requireAdmin, (req, res) => {
    const order = getOrderById(db, Number.parseInt(req.params.id, 10));
    if (!order) {
        return res.status(404).render("not-found", { title: "Commande introuvable" });
    }

    const contact = getOrderContactSnapshot(order);
    const admin = getOrderAdminData(order);
    const emailDraft = buildOrderEmailDraft(order);
    const settings = res.locals.settings;

    render(res, "admin/order-detail", {
        title: `Commande ${order.order_number}`,
        order,
        contact,
        admin,
        orderStatusOptions: ORDER_STATUS_OPTIONS,
        contactMailto: buildOrderMailto(order),
        mailConfigured: isMailConfigured(settings),
        defaultEmailSubject: emailDraft.subject,
        defaultEmailMessage: emailDraft.message,
    });
});

app.post("/admin/orders/:id/update", requireAdmin, (req, res) => {
    const order = getOrderById(db, Number.parseInt(req.params.id, 10));
    if (!order) {
        return res.status(404).render("not-found", { title: "Commande introuvable" });
    }

    const status = normalizeText(req.body.status);
    if (!ORDER_STATUS_OPTIONS.some((option) => option.value === status)) {
        setFlash(req, "error", "Statut de commande invalide.");
        return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
    }

    let createdAt = order.created_at;
    try {
        createdAt = normalizeOrderDateTimeField(req.body.order_created_at, order.created_at);
    } catch (error) {
        setFlash(req, "error", error.message);
        return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
    }

    const currentAdminData = getOrderAdminData(order);
    const nextAdminData = {
        ...currentAdminData,
        internal_note: normalizeText(req.body.internal_note),
        customer_note: normalizeText(req.body.customer_note),
        fulfillment_note: normalizeText(req.body.fulfillment_note),
        carrier: normalizeText(req.body.carrier),
        tracking_number: normalizeText(req.body.tracking_number),
        pickup_details: normalizeText(req.body.pickup_details),
    };

    let nextOrder = null;
    if (status === "paid" && order.status !== "paid") {
        const paidOrder = markOrderPaid(db, order.id, {
            admin: nextAdminData,
        });
        nextOrder = updateOrderRecord(db, paidOrder.id, {
            created_at: createdAt,
            metadata: { admin: nextAdminData },
        });
    } else {
        nextOrder = updateOrderRecord(db, order.id, {
            status,
            created_at: createdAt,
            metadata: { admin: nextAdminData },
        });
    }

    setFlash(req, "success", "Commande mise à jour.");
    return saveSessionAndRedirect(req, res, `/admin/orders/${nextOrder.id}`);
});

app.post("/admin/orders/:id/send-email", requireAdmin, async (req, res) => {
    const order = getOrderById(db, Number.parseInt(req.params.id, 10));
    if (!order) {
        return res.status(404).render("not-found", { title: "Commande introuvable" });
    }

    if (!order.customer_email) {
        setFlash(req, "error", "Aucun e-mail client n'est renseigné pour cette commande.");
        return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
    }

    const subject = normalizeSingleLineText(req.body.subject);
    const message = normalizeText(req.body.message);
    if (!subject || !message) {
        setFlash(req, "error", "Le sujet et le message sont obligatoires.");
        return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
    }

    const settings = getSettings(db);
    const configError = getMailConfigError(settings);
    if (configError) {
        setFlash(req, "error", `Envoi impossible : ${configError}`);
        return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
    }

    try {
        await sendStoreEmail(settings, {
            to: order.customer_email,
            subject,
            text: message,
        });
        setFlash(req, "success", "E-mail envoyé au client.");
    } catch (error) {
        setFlash(req, "error", `Échec de l'envoi : ${error.message}`);
    }

    return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
});

app.post("/admin/orders/:id/delete", requireAdmin, (req, res) => {
    const order = getOrderById(db, Number.parseInt(req.params.id, 10));
    if (!order) {
        setFlash(req, "error", "Commande introuvable.");
        return saveSessionAndRedirect(req, res, "/admin/orders");
    }

    deleteOrder(db, order.id);
    setFlash(req, "success", `La commande ${order.order_number} a été supprimée.`);
    return saveSessionAndRedirect(req, res, "/admin/orders");
});

app.get("/admin/products/new", requireAdmin, (req, res) => {
    render(res, "admin/product-form", {
        title: "Nouveau produit",
        formAction: "/admin/products/new",
        product: null,
        categories: listProductCategories(db),
    });
});

app.post("/admin/products/new", requireAdmin, withProductUploads, (req, res) => {
    try {
        createProduct(db, productInputWithUploads(req));
        setFlash(req, "success", "Produit créé.");
        return saveSessionAndRedirect(req, res, "/admin");
    } catch (error) {
        setFlash(req, "error", `Création impossible : ${error.message}`);
        return saveSessionAndRedirect(req, res, "/admin/products/new");
    }
});

app.get("/admin/products/:id/edit", requireAdmin, (req, res) => {
    const product = getProductById(db, Number.parseInt(req.params.id, 10));
    if (!product) {
        return res.status(404).render("not-found", { title: "Produit introuvable" });
    }

    render(res, "admin/product-form", {
        title: `Modifier ${product.name}`,
        formAction: `/admin/products/${product.id}/edit`,
        product,
        categories: listProductCategories(db),
    });
});

app.post("/admin/products/:id/edit", requireAdmin, withProductUploads, (req, res) => {
    try {
        const product = updateProduct(db, Number.parseInt(req.params.id, 10), productInputWithUploads(req));
        if (!product) {
            return res.status(404).render("not-found", { title: "Produit introuvable" });
        }

        setFlash(req, "success", "Produit mis à jour.");
        return saveSessionAndRedirect(req, res, "/admin");
    } catch (error) {
        setFlash(req, "error", `Mise à jour impossible : ${error.message}`);
        return saveSessionAndRedirect(req, res, `/admin/products/${req.params.id}/edit`);
    }
});

app.post("/admin/products/:id/delete", requireAdmin, (req, res) => {
    deleteProduct(db, Number.parseInt(req.params.id, 10));
    setFlash(req, "success", "Produit supprimé.");
    saveSessionAndRedirect(req, res, "/admin");
});

app.get("/admin/settings", requireAdmin, (req, res) => {
    render(res, "admin/settings", {
        title: "Paramètres de la boutique",
    });
});

app.post("/admin/settings", requireAdmin, withSettingsUpload, (req, res) => {
    const currentSettings = getSettings(db);
    const nextSmtpPassword = String(req.body.smtp_password || "").trim();
    saveSettings(db, {
        store_name: String(req.body.store_name || "").trim(),
        tagline: String(req.body.tagline || "").trim(),
        hero_title: String(req.body.hero_title || "").trim(),
        hero_text: String(req.body.hero_text || "").trim(),
        hero_image_url: settingsUploadUrl(req.file) || String(req.body.hero_image_url || "").trim(),
        hero_points: String(req.body.hero_points || "")
            .split(/\r?\n/)
            .map((point) => point.trim())
            .filter(Boolean)
            .join("\n"),
        support_email: String(req.body.support_email || "").trim(),
        support_address: String(req.body.support_address || "").trim(),
        bank_account_holder: String(req.body.bank_account_holder || "").trim(),
        bank_name: String(req.body.bank_name || "").trim(),
        bank_account_number: String(req.body.bank_account_number || "").trim(),
        bank_iban: String(req.body.bank_iban || "").trim(),
        bank_bic: String(req.body.bank_bic || "").trim(),
        smtp_host: String(req.body.smtp_host || "").trim(),
        smtp_port: String(req.body.smtp_port || "").trim() || "587",
        smtp_secure: req.body.smtp_secure ? "1" : "0",
        smtp_username: String(req.body.smtp_username || "").trim(),
        smtp_password: nextSmtpPassword || currentSettings.smtp_password || "",
        smtp_from_name: String(req.body.smtp_from_name || "").trim(),
        smtp_from_email: String(req.body.smtp_from_email || "").trim(),
        order_notification_email: String(req.body.order_notification_email || "").trim(),
    });

    setFlash(req, "success", "Paramètres enregistrés.");
    saveSessionAndRedirect(req, res, "/admin/settings");
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
