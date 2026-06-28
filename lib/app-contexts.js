const { createDomainServices } = require("./app-domain-context");
const { createInfrastructureContext } = require("./app-infrastructure-context");
const { getOrCreateCsrfToken, isValidCsrfToken } = require("./http/csrf");
const { createAdminAuth } = require("./http/admin-auth");
const {
    setFlash,
    getFlash,
    saveSessionAndRedirect,
    getSafeRedirectTarget,
} = require("./http/session-utils");
const { createRouteContexts } = require("./route-contexts");

function createApplicationContext(options = {}) {
    const infrastructure = createInfrastructureContext(options);
    const { db, repositories } = infrastructure;
    const auth = createAdminAuth({
        db,
        getAdminById: repositories.admins.getAdminById,
        setFlash,
        saveSessionAndRedirect,
    });
    const httpBase = {
        setFlash,
        getFlash,
        saveSessionAndRedirect,
        getSafeRedirectTarget,
        requireAdmin: auth.requireAdmin,
        requireSuperadmin: auth.requireSuperadmin,
        getLoginRateLimitState: infrastructure.rateLimiters.getLoginRateLimitState,
        registerLoginFailure: infrastructure.rateLimiters.registerLoginFailure,
        clearLoginFailures: infrastructure.rateLimiters.clearLoginFailures,
        getOrCreateCsrfToken,
    };
    const domain = createDomainServices({
        infrastructure,
        httpBase,
    });
    const http = {
        ...httpBase,
        ...domain.httpServices,
    };

    return {
        runtime: {
            config: infrastructure.config,
            db,
            maintenance: domain.maintenance,
            stop() {
                domain.stop?.();
                infrastructure.stop();
            },
        },
        middleware: {
            db,
            config: infrastructure.config,
            getOrCreateCsrfToken,
            getAdminById: repositories.admins.getAdminById,
            getViewHelpers: domain.httpServices.getViewHelpers,
            getCachedSettings: infrastructure.settingsCache.getCachedSettings,
            getFlash,
            buildCart: domain.cart.buildCart,
            paymentState: infrastructure.paymentState,
            baseUrl: infrastructure.urls.baseUrl,
            absoluteUrl: infrastructure.urls.absoluteUrl,
            isProductUploadRequest: domain.uploadMiddleware.isProductUploadRequest,
            withProductUploads: domain.uploadMiddleware.withProductUploads,
            isSettingsUploadRequest: domain.uploadMiddleware.isSettingsUploadRequest,
            withSettingsUpload: domain.uploadMiddleware.withSettingsUpload,
            isValidCsrfToken,
            setFlash,
            saveSessionAndRedirect,
        },
        createRouteContexts(app) {
            return createRouteContexts({
                app,
                infrastructure,
                domain,
                http,
            });
        },
    };
}

module.exports = { createApplicationContext };
