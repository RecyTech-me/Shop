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
        SHOP_PUBLIC_URL: "https://shop.example.test",
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

test("payment configuration normalizes values used at runtime", () => {
    const config = createAppConfig({
        rootDir,
        env: {
            NODE_ENV: "test",
            STRIPE_SECRET_KEY: "  sk_test_normalized  ",
            STRIPE_PUBLISHABLE_KEY: "  pk_test_normalized  ",
            STRIPE_WEBHOOK_SECRET: "  whsec_normalized  ",
            SWISS_BITCOIN_PAY_API_URL: "  https://sbp.example.test/  ",
            SWISS_BITCOIN_PAY_API_KEY: "  sbp-key  ",
            SWISS_BITCOIN_PAY_WEBHOOK_SECRET: "  sbp-secret  ",
        },
    });

    assert.deepEqual(config.stripe, {
        secretKey: "sk_test_normalized",
        publishableKey: "pk_test_normalized",
        webhookSecret: "whsec_normalized",
    });
    assert.deepEqual(config.swissBitcoinPay, {
        apiUrl: "https://sbp.example.test/",
        apiKey: "sbp-key",
        webhookSecret: "sbp-secret",
    });
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

test("production rejects incomplete payment provider configuration", () => {
    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            STRIPE_SECRET_KEY: "sk_live_test",
        }),
    }), /requires both STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY/);

    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            SWISS_BITCOIN_PAY_API_KEY: "sbp-key",
        }),
    }), /requires both SWISS_BITCOIN_PAY_API_KEY and SWISS_BITCOIN_PAY_WEBHOOK_SECRET/);
});

test("production refuses an unsafe Swiss Bitcoin Pay API endpoint", () => {
    for (const apiUrl of [
        "http://payments.example.test",
        "https://user:password@payments.example.test",
        "https://payments.example.test?key=value",
    ]) {
        assert.throws(() => createAppConfig({
            rootDir,
            env: productionEnv({
                SWISS_BITCOIN_PAY_API_URL: apiUrl,
                SWISS_BITCOIN_PAY_API_KEY: "sbp-key",
                SWISS_BITCOIN_PAY_WEBHOOK_SECRET: "sbp-webhook-secret-32-chars-min",
            }),
        }), /SWISS_BITCOIN_PAY_API_URL must be an HTTPS endpoint/);
    }
});

test("production requires a public HTTPS origin", () => {
    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            BASE_URL: "http://localhost:3000",
            SHOP_PUBLIC_URL: "",
            SWISS_BITCOIN_PAY_API_KEY: "sbp-key",
            SWISS_BITCOIN_PAY_WEBHOOK_SECRET: "sbp-webhook-secret-32-chars-min",
        }),
    }), /public HTTPS origin/);

    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            BASE_URL: "http://localhost:3000",
            SHOP_PUBLIC_URL: "",
            STRIPE_SECRET_KEY: "sk_live_test",
            STRIPE_PUBLISHABLE_KEY: "pk_live_test",
            STRIPE_WEBHOOK_SECRET: "whsec_test_32_chars_minimum",
        }),
    }), /public HTTPS origin/);

    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            SHOP_PUBLIC_URL: "http://shop.example.test",
            STRIPE_SECRET_KEY: "sk_live_test",
            STRIPE_PUBLISHABLE_KEY: "pk_live_test",
            STRIPE_WEBHOOK_SECRET: "whsec_test_32_chars_minimum",
        }),
    }), /public HTTPS origin/);

    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({
            SHOP_PUBLIC_URL: "http://shop.example.test",
        }),
    }), /public HTTPS origin/);
});

test("production public URLs must be bare origins", () => {
    for (const publicUrl of [
        "https://user:password@shop.example.test",
        "https://shop.example.test/store",
        "https://shop.example.test?source=config",
        "ftp://shop.example.test",
    ]) {
        assert.throws(() => createAppConfig({
            rootDir,
            env: productionEnv({ SHOP_PUBLIC_URL: publicUrl }),
        }), /must be an HTTP\(S\) origin/);
    }
});

test("production requires a canonical public origin even without external payments", () => {
    assert.throws(() => createAppConfig({
        rootDir,
        env: productionEnv({ SHOP_PUBLIC_URL: "", BASE_URL: "" }),
    }), /Missing required production URL/);
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
            SHOP_PUBLIC_URL: "https://shop.example.test",
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

test("reservation settings reject partially numeric environment values", () => {
    const config = createAppConfig({
        rootDir,
        env: {
            NODE_ENV: "test",
            PAYMENT_RESERVATION_TTL_MINUTES: "5minutes",
            PAYMENT_RESERVATION_CLEANUP_INTERVAL_MINUTES: "0disabled",
            PAYMENT_RESERVATION_CLEANUP_LIMIT: "50orders",
        },
    });

    assert.equal(config.paymentReservations.ttlMs, 60 * 60 * 1000);
    assert.equal(config.paymentReservations.cleanupIntervalMs, 15 * 60 * 1000);
    assert.equal(config.paymentReservations.cleanupLimit, 25);
});
