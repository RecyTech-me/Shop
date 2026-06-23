const express = require("express");
const session = require("express-session");
const { buildSeoMetadata } = require("../seo-metadata");
const { SqliteSessionStore, SESSION_TTL_MS } = require("../sqlite-session-store");

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
