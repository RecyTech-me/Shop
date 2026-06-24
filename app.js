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

    registerWebhookEndpoints({
        app,
        ...context.webhookRoutes,
    });

    registerAppMiddleware({
        app,
        ...context.middleware,
    });

    registerPageRoutes({
        app,
        ...context.pageRoutes,
    });

    registerFallbackRoutes({
        app,
        ...context.fallbackRoutes,
    });

    app.locals.runtime = context.runtime;

    return app;
}

module.exports = { createApp };
