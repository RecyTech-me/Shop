const { registerAdminRoutes } = require("../routes/admin");
const { registerCheckoutRoutes } = require("../routes/checkout");
const { registerHealthRoutes } = require("../routes/health");
const { registerPublicApiRoutes } = require("../routes/public-api");
const { registerStorefrontRoutes } = require("../routes/storefront");
const { registerWebhookRoutes } = require("../routes/webhooks");
const logger = require("./logger");

function registerWebhookEndpoints(context) {
    registerWebhookRoutes(context);
}

function registerPageRoutes(contexts) {
    registerHealthRoutes(contexts.health);
    registerPublicApiRoutes(contexts.publicApi);
    registerStorefrontRoutes(contexts.storefront);
    registerCheckoutRoutes(contexts.checkout);
    registerAdminRoutes(contexts.admin);
}

function registerFallbackRoutes({
    app,
    setFlash,
    saveSessionAndRedirect,
    getSafeRedirectTarget = (_value, fallback) => fallback,
}) {
    app.use((error, req, res, _next) => {
        logger.error("request.unhandled_error", {
            requestId: req.requestId,
            method: req.method,
            path: req.path,
            statusCode: 500,
            error: {
                message: error.message,
                stack: error.stack,
            },
        });

        if (req.currentAdmin) {
            setFlash(req, "error", `Erreur serveur. Référence : ${req.requestId || "indisponible"}`);
            return saveSessionAndRedirect(req, res, getSafeRedirectTarget(req.get("referer"), "/admin"));
        }

        return res.status(500).send(`Internal Server Error\nRequest ID: ${req.requestId || "unavailable"}`);
    });

    app.use((req, res) => {
        res.status(404).render("not-found", { title: "Page introuvable" });
    });
}

module.exports = {
    registerWebhookEndpoints,
    registerPageRoutes,
    registerFallbackRoutes,
};
