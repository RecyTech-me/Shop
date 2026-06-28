const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createAppConfig } = require("../lib/config");

const rootDir = path.join(__dirname, "..");

function productionEnv(overrides = {}) {
    return {
        NODE_ENV: "production",
        SESSION_SECRET: "production-session-secret-32-chars-min",
        ORDER_VIEW_TOKEN_SECRET: "production-order-view-secret-32-chars-min",
        ...overrides,
    };
}

test("production config rejects placeholder and short secrets", () => {
    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            SESSION_SECRET: "change-this-session-secret",
        }),
    }), /placeholder/);

    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            ORDER_VIEW_TOKEN_SECRET: "too-short",
        }),
    }), /at least 32/);
});

test("production payment config rejects copied placeholder keys", () => {
    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            SHOP_PUBLIC_URL: "https://shop.example.test",
            STRIPE_SECRET_KEY: "sk_test_your_secret_key",
            STRIPE_PUBLISHABLE_KEY: "pk_test_your_publishable_key",
            STRIPE_WEBHOOK_SECRET: "whsec_your_webhook_secret",
        }),
    }), /placeholder/);

    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            SHOP_PUBLIC_URL: "https://shop.example.test",
            SWISS_BITCOIN_PAY_API_KEY: "your_swiss_bitcoin_pay_api_key",
            SWISS_BITCOIN_PAY_WEBHOOK_SECRET: "choose_a_long_random_webhook_secret",
        }),
    }), /placeholder/);
});

test("production Stripe checkout requires a webhook secret when enabled", () => {
    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            SHOP_PUBLIC_URL: "https://shop.example.test",
            STRIPE_SECRET_KEY: "sk_live_test",
            STRIPE_PUBLISHABLE_KEY: "pk_live_test",
            STRIPE_WEBHOOK_SECRET: "",
        }),
    }), /STRIPE_WEBHOOK_SECRET/);
});

test("production external payments require a public base URL when enabled", () => {
    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            BASE_URL: "http://localhost:3000",
            SHOP_PUBLIC_URL: "",
            SWISS_BITCOIN_PAY_API_KEY: "sbp-key",
            SWISS_BITCOIN_PAY_WEBHOOK_SECRET: "sbp-webhook-secret-32-chars-min",
        }),
    }), /public SHOP_PUBLIC_URL or BASE_URL/);

    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            BASE_URL: "http://localhost:3000",
            SHOP_PUBLIC_URL: "",
            STRIPE_SECRET_KEY: "sk_live_test",
            STRIPE_PUBLISHABLE_KEY: "pk_live_test",
            STRIPE_WEBHOOK_SECRET: "whsec_test_32_chars_minimum",
        }),
    }), /public SHOP_PUBLIC_URL or BASE_URL/);
});

test("HTTP host and trust proxy can be configured without changing the default", () => {
    assert.equal(createAppConfig({
        rootDir,
        env: { NODE_ENV: "test" },
    }).http.trustProxy, 1);

    assert.equal(createAppConfig({
        rootDir,
        env: { NODE_ENV: "test", TRUST_PROXY: "0" },
    }).http.trustProxy, false);

    assert.equal(createAppConfig({
        rootDir,
        env: { NODE_ENV: "test", TRUST_PROXY: "2" },
    }).http.trustProxy, 2);

    assert.deepEqual(createAppConfig({
        rootDir,
        env: productionEnv({
            SHOP_PUBLIC_URL: "https://shop.example.test",
            ALLOWED_HOSTS: "admin.example.test",
        }),
    }).http.allowedHosts, ["shop.example.test", "admin.example.test"]);
});

test("logging config defaults to quiet tests and supports JSON request logs", () => {
    assert.deepEqual(createAppConfig({
        rootDir,
        env: { NODE_ENV: "test" },
    }).logging, {
        format: "text",
        level: "silent",
        requestLogs: false,
    });

    assert.deepEqual(createAppConfig({
        rootDir,
        env: {
            NODE_ENV: "production",
            SESSION_SECRET: "production-session-secret-32-chars-min",
            ORDER_VIEW_TOKEN_SECRET: "production-order-view-secret-32-chars-min",
            LOG_FORMAT: "json",
            LOG_LEVEL: "warn",
            REQUEST_LOGS: "1",
        },
    }).logging, {
        format: "json",
        level: "warn",
        requestLogs: true,
    });
});
