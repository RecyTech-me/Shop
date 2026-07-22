const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const compression = require("compression");
const session = require("express-session");
const logger = require("../logger");
const { buildSeoMetadata } = require("../seo-metadata");
const { SqliteSessionStore, SESSION_TTL_MS } = require("../sqlite-session-store");
const { getAuthenticatedAdmin } = require("./admin-auth");
const { createRequestId } = require("./request-id");
const { getSafeRedirectTarget } = require("./session-utils");

const BODY_LIMIT = "128kb";
const STATIC_ASSET_VERSION_CACHE_TTL_MS = 60 * 1000;
const PRIVATE_PAGE_PREFIXES = ["/admin", "/cart", "/checkout", "/success", "/cancel"];

function robotsDirectiveForRequest(req, statusCode) {
    const privatePage = PRIVATE_PAGE_PREFIXES.some((prefix) => (
        req.path === prefix || req.path.startsWith(`${prefix}/`)
    ));

    return privatePage || statusCode >= 400 ? "noindex,nofollow" : "index,follow";
}

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
            robots: renderOptions.robots || robotsDirectiveForRequest(req, res.statusCode),
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

function defineLazyCsrfLocal(res, req, getOrCreateCsrfToken) {
    let token = null;
    Object.defineProperty(res.locals, "csrfToken", {
        configurable: true,
        enumerable: true,
        get() {
            if (!token) {
                token = getOrCreateCsrfToken(req);
            }

            return token;
        },
    });
}

function normalizeHostHeader(value) {
    const host = String(value || "").split(",")[0].trim().toLowerCase();
    if (!host) {
        return "";
    }

    if (host.startsWith("[")) {
        return host.slice(1, host.indexOf("]"));
    }

    return host.split(":")[0];
}

function requestDurationMs(startedAt) {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function createStaticAssetHelper(publicDir) {
    const publicRoot = path.resolve(publicDir);
    const versionCache = new Map();

    return function staticAsset(assetPath) {
        const value = String(assetPath || "");
        const hashIndex = value.indexOf("#");
        const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
        const hash = hashIndex === -1 ? "" : value.slice(hashIndex);
        const queryIndex = beforeHash.indexOf("?");
        const pathname = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
        const query = queryIndex === -1 ? "" : beforeHash.slice(queryIndex);

        if (!pathname.startsWith("/static/") || /[?&]v=/.test(query)) {
            return value;
        }

        try {
            const now = Date.now();
            const relativePath = decodeURIComponent(pathname.slice("/static/".length));
            const filePath = path.resolve(publicRoot, relativePath);
            if (!filePath.startsWith(`${publicRoot}${path.sep}`)) {
                return value;
            }

            const cached = versionCache.get(filePath);
            if (cached && now - cached.checkedAt < STATIC_ASSET_VERSION_CACHE_TTL_MS) {
                return `${pathname}${query ? `${query}&` : "?"}v=${cached.version}${hash}`;
            }

            const version = Math.trunc(fs.statSync(filePath).mtimeMs).toString(36);
            versionCache.set(filePath, {
                checkedAt: now,
                version,
            });
            return `${pathname}${query ? `${query}&` : "?"}v=${version}${hash}`;
        } catch (_error) {
            return value;
        }
    };
}

function setStaticSecurityHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
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
    cleanupProductUploads,
    isSettingsUploadRequest,
    withSettingsUpload,
    cleanupSettingsUpload,
    isValidCsrfToken,
    setFlash,
    saveSessionAndRedirect,
}) {
    app.disable("x-powered-by");
    app.set("trust proxy", config.http.trustProxy);
    const staticAsset = createStaticAssetHelper(config.paths.publicDir);

    app.use((req, res, next) => {
        const requestId = createRequestId(req);
        req.requestId = requestId;
        res.locals.requestId = requestId;
        res.set("X-Request-Id", requestId);
        next();
    });

    if (config.logging.requestLogs) {
        app.use((req, res, next) => {
            const startedAt = process.hrtime.bigint();
            res.on("finish", () => {
                logger.info("request.complete", {
                    requestId: req.requestId,
                    method: req.method,
                    path: req.path,
                    statusCode: res.statusCode,
                    durationMs: Math.round(requestDurationMs(startedAt)),
                });
            });
            next();
        });
    }

    app.use((req, res, next) => {
        const allowedHosts = Array.isArray(config.http.allowedHosts) ? config.http.allowedHosts : [];
        if (!allowedHosts.length) {
            return next();
        }

        const host = normalizeHostHeader(req.get("host"));
        if (allowedHosts.includes(host)) {
            return next();
        }

        return res.status(400).send("Invalid Host header");
    });

    app.use(compression());

    app.set("view engine", "ejs");
    app.set("views", config.paths.viewsDir);
    app.use("/static/uploads", express.static(config.paths.uploadsDir, {
        maxAge: "5m",
        setHeaders: setStaticSecurityHeaders,
    }));
    app.use("/static", express.static(config.paths.publicDir, {
        maxAge: "1h",
        setHeaders(res) {
            setStaticSecurityHeaders(res);
            if (res.req?.query?.v) {
                res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            }
        },
    }));

    app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
    app.use(express.json({ limit: BODY_LIMIT }));
    const sessionStore = new SqliteSessionStore(db);
    app.use(
        session({
            store: sessionStore,
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
        defineLazyCsrfLocal(res, req, getOrCreateCsrfToken);
        const currentAdmin = getAuthenticatedAdmin(req, db, getAdminById);
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
        res.locals.staticAsset = staticAsset;
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

        cleanupRejectedUploads(req, {
            cleanupProductUploads,
            cleanupSettingsUpload,
        });

        setFlash(req, "error", "Votre session de sécurité a expiré. Veuillez réessayer.");
        return saveSessionAndRedirect(req, res, getSafeRedirectTarget(req.get("referer"), "/"));
    });

    return {
        stop() {
            sessionStore.close();
        },
    };
}

function cleanupRejectedUploads(req, {
    cleanupProductUploads = () => {},
    cleanupSettingsUpload = () => {},
} = {}) {
    if (req.productUploadsParsed) {
        cleanupProductUploads(req);
    }

    if (req.settingsUploadParsed) {
        cleanupSettingsUpload(req);
    }
}

module.exports = {
    cleanupRejectedUploads,
    registerAppMiddleware,
    robotsDirectiveForRequest,
};
