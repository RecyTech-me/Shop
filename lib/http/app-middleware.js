const express = require("express");
const crypto = require("node:crypto");
const session = require("express-session");
const { buildSeoMetadata } = require("../seo-metadata");
const { SqliteSessionStore, SESSION_TTL_MS } = require("../sqlite-session-store");

const BODY_LIMIT = "128kb";

function withSeoRender(req, res, getCachedSettings, absoluteUrl) {
    const originalRender = res.render.bind(res);

    res.render = (view, options, callback) => {
        if (typeof options === "function") {
            return originalRender(view, options);
        }

        const renderOptions = options && typeof options === "object" ? options : {};
        const seo = renderOptions.seo || buildSeoMetadata({
            title: renderOptions.title,
            settings: renderOptions.settings || res.locals.settings || getCachedSettings(),
            metaDescription: renderOptions.metaDescription,
            canonicalUrl: renderOptions.canonicalUrl ?? res.locals.canonicalUrl,
            metaImageUrl: renderOptions.metaImageUrl,
            ogType: renderOptions.ogType,
            structuredData: renderOptions.structuredData,
            absoluteUrl: res.locals.absoluteUrl || ((value) => absoluteUrl(req, value)),
        });

        return originalRender(view, {
            ...renderOptions,
            seo,
        }, callback);
    };
}

function createCspNonce() {
    return crypto.randomBytes(16).toString("base64");
}

function buildContentSecurityPolicy(nonce) {
    const nonceSource = `'nonce-${nonce}'`;

    return [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "style-src 'self'",
        `script-src 'self' ${nonceSource} https://js.stripe.com`,
        "connect-src 'self' https://api.stripe.com https://*.stripe.com https://*.stripe.network",
        "frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com",
        "worker-src 'self' blob:",
    ].join("; ");
}

function defineLazyCartLocal(res, req, buildCart) {
    let cachedCart = null;
    Object.defineProperty(res.locals, "cart", {
        configurable: true,
        enumerable: true,
        get() {
            if (!cachedCart) {
                cachedCart = buildCart(req);
            }

            return cachedCart;
        },
    });
}

function registerAppMiddleware({
    app,
    db,
    config,
    getOrCreateCsrfToken,
    getAdminById,
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
}) {
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

    app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
    app.use(express.json({ limit: BODY_LIMIT }));
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
        const cspNonce = createCspNonce();
        res.set("X-Frame-Options", "DENY");
        res.set("X-Content-Type-Options", "nosniff");
        res.set("Referrer-Policy", "strict-origin-when-cross-origin");
        res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        res.set("Content-Security-Policy", buildContentSecurityPolicy(cspNonce));
        if (requestIsSecure) {
            res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
        }

        res.locals.cspNonce = cspNonce;
        res.locals.csrfToken = getOrCreateCsrfToken(req);
        const currentAdmin = req.session.adminId ? getAdminById(db, req.session.adminId) : null;
        const hideFooter = req.path === "/cart" || req.path.startsWith("/admin");

        Object.assign(res.locals, getViewHelpers());
        res.locals.currentPath = req.path;
        res.locals.settings = getCachedSettings();
        res.locals.flash = getFlash(req);
        defineLazyCartLocal(res, req, buildCart);
        res.locals.currentAdmin = currentAdmin;
        res.locals.paymentConfig = paymentState();
        res.locals.showFooter = !hideFooter;
        res.locals.canonicalUrl = `${baseUrl(req).replace(/\/$/, "")}${req.path}`;
        res.locals.absoluteUrl = (value) => absoluteUrl(req, value);
        withSeoRender(req, res, getCachedSettings, absoluteUrl);
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
}

module.exports = { registerAppMiddleware };
