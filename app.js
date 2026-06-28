const express = require("express");
const {
    registerWebhookEndpoints,
    registerPageRoutes,
    registerFallbackRoutes,
} = require("./lib/app-routes");
const { createApplicationContext } = require("./lib/app-contexts");
const { registerAppMiddleware } = require("./lib/http/app-middleware");

function createApp(options = {}) {
    const rootDir = options.rootDir || __dirname;
    const app = express();
    const context = createApplicationContext({
        ...options,
        rootDir,
    });
    const routeContexts = context.createRouteContexts(app);

    registerWebhookEndpoints(routeContexts.webhooks);

    registerAppMiddleware({
        app,
        ...context.middleware,
    });

    registerPageRoutes(routeContexts);

    registerFallbackRoutes(routeContexts.fallback);

    app.locals.runtime = context.runtime;

    return app;
}

module.exports = { createApp };
