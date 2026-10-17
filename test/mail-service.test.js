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
            dnsTimeout: 10_000,
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

test("new order notifications report missing configuration", async (t) => {
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

    await assert.rejects(service.sendNewOrderNotification({
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
    }), /Serveur SMTP manquant/);
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


test("environment SMTP transport settings are used as a group despite database defaults", async (t) => {
    const original = nodemailer.createTransport;
    t.after(() => { nodemailer.createTransport = original; });
    nodemailer.createTransport = (config) => {
        assert.equal(config.port, 465);
        assert.equal(config.secure, true);
        assert.equal(config.auth.pass, " password with spaces ");
        return { sendMail: async () => ({ accepted: ["client@example.test"] }) };
    };
    const service = createService({ env: {
        SMTP_HOST: "smtp.example.test", SMTP_PORT: "465", SMTP_SECURE: "1",
        SMTP_USERNAME: "user", SMTP_PASSWORD: " password with spaces ",
        SMTP_FROM_EMAIL: "shop@example.test",
    } });
    await service.sendStoreEmail({ smtp_host: "", smtp_port: "587", smtp_secure: "0" }, {
        to: "client@example.test", subject: "Test", text: "Test",
    });
});

test("SMTP verification closes transport and sends no email", async (t) => {
    const original = nodemailer.createTransport;
    t.after(() => { nodemailer.createTransport = original; });
    let closed = false;
    nodemailer.createTransport = () => ({
        verify: async () => { throw new Error("authentication failed"); },
        close: () => { closed = true; },
        sendMail: () => assert.fail("must not send"),
    });
    await assert.rejects(createService().verifyMailConnection({
        smtp_host: "smtp.example.test", smtp_from_email: "shop@example.test",
    }), /authentication failed/);
    assert.equal(closed, true);
});

test("SMTP refusal is not reported as a successful send", async (t) => {
    const original = nodemailer.createTransport;
    t.after(() => { nodemailer.createTransport = original; });
    nodemailer.createTransport = () => ({ sendMail: async () => ({ accepted: [], rejected: ["client@example.test"] }) });
    await assert.rejects(createService().sendStoreEmail({
        smtp_host: "smtp.example.test", smtp_from_email: "shop@example.test",
    }, { to: "client@example.test", subject: "Test", text: "Test" }), { code: "EENVELOPE" });
});

test("customer confirmations describe payment state without exposing admin details", () => {
    const service = createService({ settings: { bank_iban: "CH-TEST", bank_account_holder: "Shop" } });
    const order = {
        order_number: "RCT-CONFIRM", customer_name: "Alice", status: "pending", provider: "cash",
        currency: "CHF", amount_cents: 9000,
        items: [{ name: "PC", quantity: 1, unit_price_cents: 10000, line_total_cents: 10000 }],
        metadata: { delivery: { label: "Retrait" }, additions: [{ label: "Réduction espèces", amount_cents: -1000 }], admin_notes: "PRIVATE" },
    };
    let message = service.buildCustomerConfirmation(order);
    assert.match(message.text, /90.00 CHF/);
    assert.match(message.text, /espèces se fera lors du retrait/);
    assert.doesNotMatch(message.text, /Paiement reçu|PRIVATE|\/admin/);
    message = service.buildCustomerConfirmation({ ...order, provider: "transfer" });
    assert.match(message.text, /CH-TEST/);
    assert.match(message.text, /Référence à indiquer : RCT-CONFIRM/);
    message = service.buildCustomerConfirmation({ ...order, provider: "stripe" });
    assert.match(message.text, /pas encore confirmé/);
    message = service.buildCustomerConfirmation({ ...order, status: "paid" });
    assert.match(message.text, /Paiement reçu/);
    assert.doesNotMatch(message.text, /espèces se fera/);
});


test("delayed confirmations recognize payments after fulfillment advances", () => {
    const service = createService();
    for (const status of ["processing", "ready_for_pickup", "shipped", "completed"]) {
        const message = service.buildCustomerConfirmation({
            order_number: "RCT-DELAYED", customer_name: "Alice", status, provider: "transfer",
            currency: "CHF", amount_cents: 1000, items: [], metadata: {},
        });
        assert.match(message.text, /Paiement reçu/, status);
        assert.doesNotMatch(message.text, /en attente de votre virement/, status);
    }
});

test("queued deliveries target team and customer separately with stable message identifiers", async (t) => {
    const original = nodemailer.createTransport;
    t.after(() => { nodemailer.createTransport = original; });
    const messages = [];
    nodemailer.createTransport = () => ({ sendMail: async (message) => {
        messages.push(message);
        return { accepted: [message.to] };
    } });
    const service = createService({ settings: {
        smtp_host: "smtp.example.test", smtp_from_email: "shop@example.test",
        order_notification_email: "team@example.test",
    } });
    const order = {
        id: 12, order_number: "RCT-DELIVERY", customer_name: "Alice", customer_email: "client@example.test",
        status: "pending", provider: "cash", currency: "CHF", amount_cents: 1000, items: [], metadata: {},
    };
    await service.sendOrderMail(order, "team");
    await service.sendOrderMail(order, "customer");
    await service.sendOrderMail(order, "customer");
    assert.equal(messages[0].to, "team@example.test");
    assert.equal(messages[1].to, "client@example.test");
    assert.notEqual(messages[0].messageId, messages[1].messageId);
    assert.equal(messages[1].messageId, messages[2].messageId);
    assert.match(messages[1].subject, /Commande reçue/);
    assert.doesNotMatch(messages[1].text, /Administration/);
});
