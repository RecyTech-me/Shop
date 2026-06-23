const path = require("path");
const crypto = require("crypto");

function requireProductionSecrets(env, names) {
    if (env.NODE_ENV !== "production") {
        return;
    }

    const missingSecrets = names
        .filter((name) => !String(env[name] || "").trim());

    if (missingSecrets.length) {
        throw new Error(`Missing required production secret(s): ${missingSecrets.join(", ")}`);
    }
}

function createAppConfig({ env = process.env, rootDir }) {
    requireProductionSecrets(env, [
        "SESSION_SECRET",
        "ORDER_VIEW_TOKEN_SECRET",
    ]);

    return {
        env,
        paths: {
            database: path.join(rootDir, "storage", "shop.db"),
            productUploads: path.join(rootDir, "public", "uploads", "products"),
            settingsUploads: path.join(rootDir, "public", "uploads", "settings"),
            publicDir: path.join(rootDir, "public"),
            uploadsDir: path.join(rootDir, "public", "uploads"),
            viewsDir: path.join(rootDir, "views"),
        },
        session: {
            secret: String(env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")).trim(),
        },
        orderViews: {
            tokenSecret: String(env.ORDER_VIEW_TOKEN_SECRET || "").trim(),
        },
        stripe: {
            secretKey: String(env.STRIPE_SECRET_KEY || "").trim(),
            publishableKey: String(env.STRIPE_PUBLISHABLE_KEY || ""),
        },
        swissBitcoinPay: {
            apiUrl: env.SWISS_BITCOIN_PAY_API_URL,
            apiKey: env.SWISS_BITCOIN_PAY_API_KEY,
            webhookSecret: env.SWISS_BITCOIN_PAY_WEBHOOK_SECRET,
        },
    };
}

module.exports = { createAppConfig };
