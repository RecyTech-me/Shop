const assert = require("node:assert/strict");
const test = require("node:test");
const nodemailer = require("nodemailer");
const { createMailService } = require("../lib/mail-service");

function createService(overrides = {}) {
    return createMailService({
        env: overrides.env || {},
        getSettings: () => overrides.settings || {},
        normalizeText: (value) => String(value || "").trim(),
        parseInteger: (value, fallback) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isInteger(parsed) ? parsed : fallback;
        },
        toBoolean: (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase()),
        formatMoney: (cents, currency = "CHF") => `${(cents / 100).toFixed(2)} ${currency}`,
        formatDateTime: (value) => value,
        getOrderContactSnapshot: () => ({
            phone: "",
            shippingLines: [],
            billingLines: [],
        }),
        getOrderProviderLabel: (provider) => provider,
        getOrderStatusLabel: (status) => status,
    });
}

test("mail service reports configuration errors before sending", async () => {
    const service = createService();

    assert.equal(service.getMailConfigError({}), "Serveur SMTP manquant.");
    assert.equal(service.getMailConfigError({
        smtp_host: "smtp.example.test",
        smtp_port: "0",
        smtp_from_email: "shop@example.test",
    }), "Port SMTP invalide.");
    assert.equal(service.getMailConfigError({
        smtp_host: "smtp.example.test",
        smtp_port: "587",
        smtp_username: "user",
        smtp_from_email: "shop@example.test",
    }), "Les identifiants SMTP sont incomplets.");
    await assert.rejects(
        service.sendStoreEmail({}, {
            to: "client@example.test",
            subject: "Test",
            text: "Hello",
        }),
        /Serveur SMTP manquant/
    );
});

test("mail service sends text and escaped HTML through nodemailer", async (t) => {
    const originalCreateTransport = nodemailer.createTransport;
    const sentMessages = [];
    const service = createService();

    t.after(() => {
        nodemailer.createTransport = originalCreateTransport;
    });

    nodemailer.createTransport = (config) => {
        assert.deepEqual(config, {
            host: "smtp.example.test",
            port: 587,
            secure: false,
            requireTLS: false,
            auth: { user: "smtp-user", pass: "smtp-pass" },
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 30_000,
        });

        return {
            sendMail: async (message) => {
                sentMessages.push(message);
                return { messageId: "message-1" };
            },
        };
    };

    await service.sendStoreEmail({
        smtp_host: "smtp.example.test",
        smtp_port: "587",
        smtp_secure: "0",
        smtp_username: "smtp-user",
        smtp_password: "smtp-pass",
        smtp_from_name: "RecyTech",
        smtp_from_email: "shop@example.test",
        support_email: "support@example.test",
    }, {
        to: "client@example.test",
        subject: "Commande",
        text: "Bonjour\n\n<script>alert(1)</script>",
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].from.address, "shop@example.test");
    assert.equal(sentMessages[0].replyTo, "support@example.test");
    assert.equal(sentMessages[0].to, "client@example.test");
    assert.equal(sentMessages[0].text, "Bonjour\n\n<script>alert(1)</script>");
    assert.match(sentMessages[0].html, /<p>Bonjour<\/p>/);
    assert.match(sentMessages[0].html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("production SMTP requires STARTTLS when implicit TLS is disabled", async (t) => {
    const originalCreateTransport = nodemailer.createTransport;
    const service = createService({ env: { NODE_ENV: "production" } });

    t.after(() => {
        nodemailer.createTransport = originalCreateTransport;
    });

    nodemailer.createTransport = (config) => {
        assert.equal(config.secure, false);
        assert.equal(config.requireTLS, true);
        return { sendMail: async () => ({ messageId: "message-starttls" }) };
    };

    await service.sendStoreEmail({
        smtp_host: "smtp.example.test",
        smtp_port: "587",
        smtp_secure: "0",
        smtp_from_email: "shop@example.test",
    }, {
        to: "client@example.test",
        subject: "Commande",
        text: "Bonjour",
    });
});

test("new order notifications no-op when mail is not configured", async (t) => {
    const originalCreateTransport = nodemailer.createTransport;
    const service = createService({
        settings: {
            order_notification_email: "team@example.test",
        },
    });

    t.after(() => {
        nodemailer.createTransport = originalCreateTransport;
    });
    nodemailer.createTransport = () => {
        throw new Error("transport should not be created");
    };

    await service.sendNewOrderNotification({
        id: 1,
        order_number: "RCT-NOMAIL",
        provider: "transfer",
        status: "pending",
        customer_name: "Client",
        customer_email: "client@example.test",
        amount_cents: 1200,
        currency: "CHF",
        items: [],
        metadata: {},
        created_at: "2026-06-28T12:00:00.000Z",
    });
});

test("new order notifications prefer the canonical shop URL", async (t) => {
    const originalCreateTransport = nodemailer.createTransport;
    const sentMessages = [];
    const settings = {
        smtp_host: "smtp.example.test",
        smtp_port: "587",
        smtp_from_email: "shop@example.test",
        order_notification_email: "team@example.test",
    };
    const service = createService({
        env: {
            BASE_URL: "http://localhost:3000",
            SHOP_PUBLIC_URL: "https://shop.example.test",
        },
        settings,
    });

    t.after(() => {
        nodemailer.createTransport = originalCreateTransport;
    });
    nodemailer.createTransport = () => ({
        sendMail: async (message) => {
            sentMessages.push(message);
            return { messageId: "message-canonical-url" };
        },
    });

    await service.sendNewOrderNotification({
        id: 42,
        order_number: "RCT-CANONICAL",
        provider: "transfer",
        status: "pending",
        customer_name: "Client",
        customer_email: "client@example.test",
        amount_cents: 1200,
        currency: "CHF",
        items: [],
        metadata: {},
        created_at: "2026-07-21T12:00:00.000Z",
    });

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text, /https:\/\/shop\.example\.test\/admin\/orders\/42/);
    assert.doesNotMatch(sentMessages[0].text, /localhost/);
});
