const { registerAdminRoutes } = require("../routes/admin");
const { registerCheckoutRoutes } = require("../routes/checkout");
const { registerPublicApiRoutes } = require("../routes/public-api");
const { registerStorefrontRoutes } = require("../routes/storefront");
const { registerWebhookRoutes } = require("../routes/webhooks");
const logger = require("./logger");

function registerWebhookEndpoints({
    app,
    db,
    providers,
    repositories,
    payments,
    text,
}) {
    registerWebhookRoutes({
        app,
        db,
        providers,
        repositories,
        payments,
        text,
    });
}

function registerPageRoutes({
    app,
    db,
    providers,
    http,
    text,
    money,
    forms,
    formatters,
    urls,
    publicProducts,
    cart,
    checkout,
    uploads,
    mail,
    payments,
    settings,
    products,
    admins,
    reviews,
    promos,
    dashboard,
    orders,
}) {
    registerPublicApiRoutes({
        app,
        db,
        providers,
        http,
        text,
        publicProducts,
        cart,
        checkout,
        payments,
        products,
        orders,
        mail,
    });

    registerStorefrontRoutes({
        app,
        db,
        http,
        text,
        money,
        forms,
        publicProducts,
        cart,
        products,
        reviews,
    });

    registerCheckoutRoutes({
        app,
        db,
        providers,
        formatters,
        http,
        cart,
        checkout,
        forms,
        payments,
        orders,
        mail,
    });

    registerAdminRoutes({
        app,
        db,
        http,
        text,
        money,
        forms,
        formatters,
        urls,
        publicProducts,
        cart,
        checkout,
        uploads,
        mail,
        settings,
        products,
        admins,
        reviews,
        promos,
        dashboard,
        orders,
    });
}

function registerFallbackRoutes({
    app,
    setFlash,
    saveSessionAndRedirect,
}) {
    app.use((error, req, res, _next) => {
        logger.error(error);

        if (req.currentAdmin) {
            setFlash(req, "error", `Erreur serveur : ${error.message}`);
            return saveSessionAndRedirect(req, res, req.get("referer") || "/admin");
        }

        return res.status(500).send("Internal Server Error");
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
