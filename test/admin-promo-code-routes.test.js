const assert = require("node:assert/strict");
const test = require("node:test");
const { registerAdminPromoCodeRoutes } = require("../routes/admin-modules/promo-codes");

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
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        render(view, options) {
            this.rendered = { view, options };
            return this;
        },
        redirect(target) {
            this.redirectedTo = target;
            return this;
        },
    };
}

function createRequest(options = {}) {
    return {
        body: {},
        params: {},
        flashes: [],
        ...options,
    };
}

function createPromoCode(overrides = {}) {
    return {
        id: 7,
        code: "SUMMER20",
        discount_type: "percent",
        discount_value: 20,
        active: true,
        ...overrides,
    };
}

function registerRoutes(overrides = {}) {
    const handlers = new Map();
    const calls = [];
    const promoCode = Object.prototype.hasOwnProperty.call(overrides, "promoCode")
        ? overrides.promoCode
        : createPromoCode();
    const defaultPromos = {
        listPromoCodes: () => [promoCode].filter(Boolean),
        getPromoCodeById: () => promoCode,
        createPromoCodeRecord: (_db, input) => {
            calls.push(["create", input]);
            return createPromoCode(input);
        },
        updatePromoCodeRecord: (_db, id, input) => {
            calls.push(["update", id, input]);
            return promoCode ? { ...promoCode, ...input } : null;
        },
        deletePromoCodeRecord: (_db, id) => {
            calls.push(["delete", id]);
            return true;
        },
    };
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
            render: (res, view, options) => res.render(view, options),
            setFlash: (req, type, message) => {
                calls.push(["flash", type, message]);
                req.flashes.push({ type, message });
            },
            saveSessionAndRedirect: (req, res, target) => {
                calls.push(["redirect", target]);
                return res.redirect(target);
            },
        },
        forms: {
            readPromoCodeInput: (body) => {
                if (body.invalid) {
                    throw new Error("Code promo invalide.");
                }
                return { code: body.code || "SUMMER20", active: 1 };
            },
            ...overrides.forms,
        },
        promos: {
            ...defaultPromos,
            ...overrides.promos,
        },
    };

    registerAdminPromoCodeRoutes(deps);
    return {
        calls,
        handler(method, path) {
            return handlers.get(`${method} ${path}`);
        },
    };
}

test("promo code list and creation form render repository data", async () => {
    const { handler } = registerRoutes();
    const listResponse = createResponse();
    const formResponse = createResponse();

    await handler("GET", "/admin/promo-codes")(createRequest(), listResponse);
    await handler("GET", "/admin/promo-codes/new")(createRequest(), formResponse);

    assert.equal(listResponse.rendered.view, "admin/promo-codes");
    assert.equal(listResponse.rendered.options.promoCodes[0].code, "SUMMER20");
    assert.equal(formResponse.rendered.view, "admin/promo-code-form");
    assert.equal(formResponse.rendered.options.formAction, "/admin/promo-codes/new");
});

test("promo code creation redirects with success after persistence", async () => {
    const { calls, handler } = registerRoutes();
    const req = createRequest({ body: { code: "NEW20" } });
    const res = createResponse();

    await handler("POST", "/admin/promo-codes/new")(req, res);

    assert.equal(res.redirectedTo, "/admin/promo-codes");
    assert.deepEqual(calls.find((call) => call[0] === "create")[1], { code: "NEW20", active: 1 });
    assert.ok(req.flashes.some((flash) => flash.type === "success"));
});

test("promo code creation reports validation and unique-constraint errors", async () => {
    const validationRoutes = registerRoutes();
    const invalidRequest = createRequest({ body: { invalid: true } });
    const invalidResponse = createResponse();
    await validationRoutes.handler("POST", "/admin/promo-codes/new")(invalidRequest, invalidResponse);

    const duplicate = new Error("duplicate");
    duplicate.code = "SQLITE_CONSTRAINT_UNIQUE";
    const duplicateRoutes = registerRoutes({
        promos: {
            createPromoCodeRecord: () => {
                throw duplicate;
            },
        },
    });
    const duplicateRequest = createRequest({ body: { code: "EXISTS" } });
    const duplicateResponse = createResponse();
    await duplicateRoutes.handler("POST", "/admin/promo-codes/new")(duplicateRequest, duplicateResponse);

    assert.equal(invalidResponse.redirectedTo, "/admin/promo-codes/new");
    assert.match(invalidRequest.flashes[0].message, /invalide/);
    assert.equal(duplicateResponse.redirectedTo, "/admin/promo-codes/new");
    assert.match(duplicateRequest.flashes[0].message, /existe déjà/);
});

test("promo code edit form returns 404 when absent and renders when present", async () => {
    const missingRoutes = registerRoutes({ promoCode: null });
    const missingResponse = createResponse();
    await missingRoutes.handler("GET", "/admin/promo-codes/:id/edit")(
        createRequest({ params: { id: "404" } }),
        missingResponse
    );

    const foundRoutes = registerRoutes();
    const foundResponse = createResponse();
    await foundRoutes.handler("GET", "/admin/promo-codes/:id/edit")(
        createRequest({ params: { id: "7" } }),
        foundResponse
    );

    assert.equal(missingResponse.statusCode, 404);
    assert.equal(missingResponse.rendered.view, "not-found");
    assert.equal(foundResponse.rendered.options.formAction, "/admin/promo-codes/7/edit");
});

test("promo code update handles success, missing records, and unique conflicts", async () => {
    const successRoutes = registerRoutes();
    const successRequest = createRequest({ params: { id: "7" }, body: { code: "UPDATED" } });
    const successResponse = createResponse();
    await successRoutes.handler("POST", "/admin/promo-codes/:id/edit")(successRequest, successResponse);

    const missingRoutes = registerRoutes({ promoCode: null });
    const missingResponse = createResponse();
    await missingRoutes.handler("POST", "/admin/promo-codes/:id/edit")(
        createRequest({ params: { id: "8" }, body: { code: "MISSING" } }),
        missingResponse
    );

    const duplicate = new Error("duplicate");
    duplicate.code = "SQLITE_CONSTRAINT_UNIQUE";
    const duplicateRoutes = registerRoutes({
        promos: {
            updatePromoCodeRecord: () => {
                throw duplicate;
            },
        },
    });
    const duplicateRequest = createRequest({ params: { id: "7" }, body: { code: "EXISTS" } });
    const duplicateResponse = createResponse();
    await duplicateRoutes.handler("POST", "/admin/promo-codes/:id/edit")(duplicateRequest, duplicateResponse);

    assert.equal(successResponse.redirectedTo, "/admin/promo-codes");
    assert.ok(successRequest.flashes.some((flash) => flash.type === "success"));
    assert.equal(missingResponse.statusCode, 404);
    assert.equal(duplicateResponse.redirectedTo, "/admin/promo-codes/7/edit");
    assert.match(duplicateRequest.flashes[0].message, /existe déjà/);
});

test("promo code deletion distinguishes missing and persisted records", async () => {
    const missingRoutes = registerRoutes({ promoCode: null });
    const missingRequest = createRequest({ params: { id: "9" } });
    const missingResponse = createResponse();
    await missingRoutes.handler("POST", "/admin/promo-codes/:id/delete")(missingRequest, missingResponse);

    const successRoutes = registerRoutes();
    const successRequest = createRequest({ params: { id: "7" } });
    const successResponse = createResponse();
    await successRoutes.handler("POST", "/admin/promo-codes/:id/delete")(successRequest, successResponse);

    assert.equal(missingResponse.redirectedTo, "/admin/promo-codes");
    assert.match(missingRequest.flashes[0].message, /introuvable/);
    assert.deepEqual(successRoutes.calls.find((call) => call[0] === "delete"), ["delete", 7]);
    assert.match(successRequest.flashes[0].message, /SUMMER20/);
});
