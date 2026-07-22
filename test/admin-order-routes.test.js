const assert = require("node:assert/strict");
const test = require("node:test");
const { registerAdminOrderRoutes } = require("../routes/admin-modules/orders");

function composeHandlers(handlers) {
    return async function composed(req, res) {
        let index = 0;
        async function next() {
            const handler = handlers[index];
            index += 1;
            if (handler) {
                await handler(req, res, next);
            }
        }

        await next();
    };
}

function createResponse() {
    return {
        locals: {
            settings: {},
        },
        statusCode: 200,
        redirects: [],
        renders: [],
        sent: null,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        render(view, options) {
            this.renders.push({ view, options });
            this.rendered = { view, options };
            return this;
        },
        redirect(target) {
            this.redirects.push(target);
            this.redirectedTo = target;
            return this;
        },
        set(headers) {
            this.headers = { ...this.headers, ...headers };
            return this;
        },
        send(payload) {
            this.sent = payload;
            return this;
        },
    };
}

function createOrder(overrides = {}) {
    return {
        id: 12,
        order_number: "RCT-ORDER",
        provider: "transfer",
        status: "pending",
        customer_name: "Order Customer",
        customer_email: "client@example.test",
        amount_cents: 2000,
        currency: "CHF",
        items: [],
        metadata: {},
        created_at: "2026-06-28T12:00:00.000Z",
        ...overrides,
    };
}

function registerRoutes(overrides = {}) {
    const handlers = new Map();
    const calls = [];
    let currentOrder = Object.prototype.hasOwnProperty.call(overrides, "order")
        ? overrides.order
        : createOrder();
    const deps = {
        app: {
            get(path, ...routeHandlers) {
                handlers.set(`GET ${path}`, composeHandlers(routeHandlers));
            },
            post(path, ...routeHandlers) {
                handlers.set(`POST ${path}`, composeHandlers(routeHandlers));
            },
        },
        db: {},
        http: {
            requireAdmin: (req, res, next) => next(),
            render: (res, view, options) => {
                calls.push(["render", view, options]);
                res.render(view, options);
            },
            setFlash: (req, type, message) => {
                calls.push(["flash", type, message]);
                req.flashes.push({ type, message });
            },
            saveSessionAndRedirect: (req, res, target) => {
                calls.push(["redirect", target]);
                res.redirect(target);
            },
        },
        text: {
            normalizeText: (value) => String(value || "").trim(),
            normalizeSingleLineText: (value) => String(value || "").trim().replace(/\s+/g, " "),
            parseInteger: (value, fallback) => /^\d+$/.test(String(value || "")) ? Number(value) : fallback,
        },
        money: {
            parseMoneyToCents: () => 0,
            parseOptionalMoneyToCents: () => null,
            normalizeOrderDateTimeField: (value, fallback) => value || fallback,
        },
        forms: {
            readSelectedProductOptions: () => [],
        },
        publicProducts: {
            productCategoryList: () => [],
        },
        cart: {
            ensureAvailableProductQuantity: () => {},
            validateRequestedServiceTags: () => {},
            getProductUnitPriceCents: () => 0,
            getConfigurationAvailableQuantity: () => 0,
            snapshotPackBundleItems: () => [],
        },
        checkout: {
            normalizePromoCode: (value) => String(value || "").trim().toUpperCase(),
            getPromoCodeOutcome: () => ({ error: "", code: "" }),
            getPromoCodeLabel: () => "",
        },
        urls: {
            baseUrl: () => "https://shop.example.test",
            getOrderDocumentConfig: () => ({}),
        },
        settings: {
            getSettings: () => overrides.settings || {},
        },
        products: {
            listAdminProducts: () => [],
            getProductById: () => null,
        },
        promos: {
            listPromoCodes: () => [],
        },
        orders: {
            getOrderContactSnapshot: () => ({ shippingLines: [], billingLines: [] }),
            getOrderAdminData: (order) => order.metadata.admin || {},
            buildOrderMailto: () => "mailto:client@example.test",
            canEditOrderReceivedAmount: () => false,
            readReceivedPaymentInput: () => ({}),
            getOrderPaymentData: () => ({}),
            createOrder: () => createOrder(),
            getOrderById: () => currentOrder,
            updateOrderRecord: (db, orderId, updates) => {
                calls.push(["updateOrderRecord", orderId, updates]);
                currentOrder = { ...currentOrder, status: updates.status || currentOrder.status, metadata: updates.metadata || currentOrder.metadata };
                return currentOrder;
            },
            markOrderPaid: (db, orderId, metadata) => {
                calls.push(["markOrderPaid", orderId, metadata]);
                currentOrder = { ...currentOrder, status: "paid", metadata: { ...currentOrder.metadata, ...metadata } };
                return currentOrder;
            },
            listOrders: (db, filters) => {
                calls.push(["listOrders", filters]);
                return [currentOrder].filter(Boolean);
            },
            countOrders: (db, filters) => {
                calls.push(["countOrders", filters]);
                return overrides.totalOrders ?? 1;
            },
            deleteOrder: (db, orderId) => {
                calls.push(["deleteOrder", orderId]);
                currentOrder = null;
                return true;
            },
            ...overrides.orders,
        },
        mail: {
            buildOrderEmailDraft: (order) => ({
                subject: `Commande ${order.order_number}`,
                message: "Bonjour",
            }),
            isMailConfigured: () => true,
            getMailConfigError: () => "",
            sendStoreEmail: async (_settings, message) => {
                calls.push(["sendStoreEmail", message]);
            },
            ...overrides.mail,
        },
    };

    registerAdminOrderRoutes(deps);

    return {
        calls,
        handler(method, path) {
            return handlers.get(`${method} ${path}`);
        },
    };
}

function createRequest(options = {}) {
    return {
        query: {},
        body: {},
        params: {},
        currentAdmin: { username: "admin" },
        flashes: [],
        ...options,
    };
}

test("admin order list applies pagination and filters", async () => {
    const { calls, handler } = registerRoutes({ totalOrders: 120 });
    const req = createRequest({
        query: {
            status: "paid",
            q: "ada",
            page: "3",
        },
    });
    const res = createResponse();

    await handler("GET", "/admin/orders")(req, res);

    assert.equal(res.rendered.view, "admin/orders");
    assert.deepEqual(calls.find((call) => call[0] === "countOrders")[1], {
        status: "paid",
        query: "ada",
    });
    assert.deepEqual(calls.find((call) => call[0] === "listOrders")[1], {
        status: "paid",
        query: "ada",
        limit: 50,
        offset: 100,
    });
    assert.equal(res.rendered.options.pagination.page, 3);
});

test("admin order detail returns 404 for missing orders", async () => {
    const { handler } = registerRoutes({ order: null });
    const req = createRequest({ params: { id: "99" } });
    const res = createResponse();

    await handler("GET", "/admin/orders/:id")(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.rendered.view, "not-found");
});

test("admin order update rejects invalid statuses without mutation", async () => {
    const { calls, handler } = registerRoutes();
    const req = createRequest({
        params: { id: "12" },
        body: { status: "not-a-status" },
    });
    const res = createResponse();

    await handler("POST", "/admin/orders/:id/update")(req, res);

    assert.equal(res.redirectedTo, "/admin/orders/12");
    assert.ok(calls.some((call) => call[0] === "flash" && /Statut de commande invalide/.test(call[2])));
    assert.ok(!calls.some((call) => call[0] === "updateOrderRecord"));
});

test("admin order email rejects missing customer email", async () => {
    const { calls, handler } = registerRoutes({
        order: createOrder({ customer_email: "" }),
    });
    const req = createRequest({
        params: { id: "12" },
        body: { subject: "Sujet", message: "Message" },
    });
    const res = createResponse();

    await handler("POST", "/admin/orders/:id/send-email")(req, res);

    assert.equal(res.redirectedTo, "/admin/orders/12");
    assert.ok(calls.some((call) => call[0] === "flash" && /Aucun e-mail/.test(call[2])));
    assert.ok(!calls.some((call) => call[0] === "sendStoreEmail"));
});

test("admin order email rejects incomplete SMTP configuration", async () => {
    const { calls, handler } = registerRoutes({
        mail: {
            getMailConfigError: () => "Serveur SMTP manquant.",
        },
    });
    const req = createRequest({
        params: { id: "12" },
        body: { subject: "Sujet", message: "Message" },
    });
    const res = createResponse();

    await handler("POST", "/admin/orders/:id/send-email")(req, res);

    assert.equal(res.redirectedTo, "/admin/orders/12");
    assert.ok(calls.some((call) => call[0] === "flash" && /Envoi impossible/.test(call[2])));
    assert.ok(!calls.some((call) => call[0] === "sendStoreEmail"));
});

test("admin order delete handles missing and existing orders", async () => {
    const missing = registerRoutes({ order: null });
    const missingReq = createRequest({ params: { id: "999" } });
    const missingRes = createResponse();

    await missing.handler("POST", "/admin/orders/:id/delete")(missingReq, missingRes);

    assert.equal(missingRes.redirectedTo, "/admin/orders");
    assert.ok(missing.calls.some((call) => call[0] === "flash" && /introuvable/.test(call[2])));
    assert.ok(!missing.calls.some((call) => call[0] === "deleteOrder"));

    const existing = registerRoutes();
    const existingReq = createRequest({ params: { id: "12" } });
    const existingRes = createResponse();

    await existing.handler("POST", "/admin/orders/:id/delete")(existingReq, existingRes);

    assert.equal(existingRes.redirectedTo, "/admin/orders");
    assert.ok(existing.calls.some((call) => call[0] === "deleteOrder" && call[1] === 12));
    assert.ok(existing.calls.some((call) => call[0] === "flash" && /a été supprimée/.test(call[2])));
});

test("admin order delete reports protected order history", async () => {
    const routes = registerRoutes({
        orders: {
            deleteOrder: () => {
                throw new Error("Cette commande doit être conservée.");
            },
        },
    });
    const req = createRequest({ params: { id: "12" } });
    const res = createResponse();

    await routes.handler("POST", "/admin/orders/:id/delete")(req, res);

    assert.equal(res.redirectedTo, "/admin/orders");
    assert.ok(routes.calls.some((call) => call[0] === "flash" && call[1] === "error" && /conservée/.test(call[2])));
});
