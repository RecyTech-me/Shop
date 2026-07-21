const assert = require("node:assert/strict");
const test = require("node:test");
const { registerStorefrontRoutes } = require("../routes/storefront");
const logger = require("../lib/logger");

logger.configureLogger({ level: "silent" });

function registerRoutes(overrides = {}) {
    const handlers = new Map();
    const calls = [];
    const reviews = [];
    const deps = {
        app: {
            get() {},
            post(path, handler) {
                handlers.set(path, handler);
            },
        },
        db: {},
        http: {
            render: () => {},
            setFlash: (req, type, message) => {
                calls.push(["flash", type, message]);
                req.flashes.push({ type, message });
            },
            saveSessionAndRedirect: (req, res, target) => {
                calls.push(["redirect", target]);
                res.redirect(target);
            },
            getSafeRedirectTarget: (_value, fallback) => fallback,
        },
        rateLimiters: {
            getReviewSubmissionRateLimitState: () => ({ blockedUntil: 0 }),
            registerReviewSubmissionAttempt: (req) => {
                calls.push(["registerReviewAttempt", req.ip || "unknown"]);
            },
            ...overrides.rateLimiters,
        },
        text: {
            normalizeText: (value) => String(value || "").trim(),
            parseInteger: (value, fallback) => /^\d+$/.test(String(value || ""))
                ? Number.parseInt(value, 10)
                : fallback,
        },
        money: {
            parseMoneyToCents: () => Number.NaN,
        },
        forms: {
            readSiteReviewInput: (body) => {
                if (!body.rating) {
                    throw new Error("Note obligatoire.");
                }

                return {
                    rating: Number(body.rating),
                    reviewer_name: String(body.reviewer_name || "Client"),
                    reviewer_email: "",
                    title: "Avis",
                    body: "Très bien.",
                };
            },
            readSelectedProductOptions: () => [],
        },
        publicProducts: {
            productMetaDescription: () => "",
            productStructuredData: () => null,
            organizationStructuredData: () => null,
        },
        cart: {
            ensureAvailableProductQuantity: () => {},
            upsertCartItem: () => {},
            getCartItems: () => [],
            makeCartItemKey: () => "key",
            removeCartItem: () => {},
            ...overrides.cart,
        },
        products: {
            listPublishedProducts: () => [],
            listProductCategories: () => [],
            getProductBySlug: () => null,
            getProductById: () => null,
            ...overrides.products,
        },
        reviews: {
            listApprovedSiteReviews: () => [],
            getSiteReviewSummary: () => ({ count: 0, average: 0 }),
            createSiteReview: (_db, input) => {
                calls.push(["createSiteReview", input.rating]);
                reviews.push(input);
            },
            ...overrides.reviews,
        },
    };

    registerStorefrontRoutes(deps);

    return {
        calls,
        reviews,
        handler: handlers.get("/reviews"),
        handlers,
    };
}

function createRequest(body = {}, session = {}) {
    return {
        body,
        session,
        flashes: [],
        ip: "203.0.113.10",
    };
}

function createResponse() {
    return {
        redirects: [],
        redirect(target) {
            this.redirects.push(target);
            this.redirectedTo = target;
            return this;
        },
    };
}

test("review submission stamps session throttle after a valid review", () => {
    const { calls, reviews, handler } = registerRoutes();
    const session = {};
    const req = createRequest({ rating: "5" }, session);
    const res = createResponse();

    handler(req, res);

    assert.equal(res.redirectedTo, "/#reviews");
    assert.equal(reviews.length, 1);
    assert.equal(typeof session.lastReviewSubmissionAt, "number");
    assert.ok(calls.some((call) => call[0] === "registerReviewAttempt"));
    assert.ok(calls.some((call) => call[0] === "flash" && call[1] === "success"));
});

test("review submission rejects immediate second review from the same session", () => {
    const { calls, reviews, handler } = registerRoutes();
    const session = {};
    const firstReq = createRequest({ rating: "5" }, session);

    handler(firstReq, createResponse());
    handler(createRequest({ rating: "4" }, session), createResponse());

    assert.equal(reviews.length, 1);
    assert.equal(calls.filter((call) => call[0] === "registerReviewAttempt").length, 1);
    assert.ok(calls.some((call) => call[0] === "flash" && /Veuillez patienter/.test(call[2])));
});

test("invalid review input does not stamp successful throttle", () => {
    const { calls, reviews, handler } = registerRoutes();
    const session = {};
    const req = createRequest({}, session);
    const res = createResponse();

    handler(req, res);

    assert.equal(res.redirectedTo, "/#reviews");
    assert.equal(reviews.length, 0);
    assert.equal(session.lastReviewSubmissionAt, undefined);
    assert.ok(!calls.some((call) => call[0] === "registerReviewAttempt"));
    assert.ok(calls.some((call) => call[0] === "flash" && /Note obligatoire/.test(call[2])));
});

test("review submission does not expose database errors", () => {
    const { calls, handler } = registerRoutes({
        reviews: {
            createSiteReview: () => {
                throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
            },
        },
    });

    handler(createRequest({ rating: "5" }), createResponse());

    assert.ok(calls.some((call) => call[0] === "flash" && /Impossible d'enregistrer votre avis/.test(call[2])));
    assert.ok(!calls.some((call) => call[0] === "flash" && /database is locked/.test(call[2])));
});

test("review submission rejects IP-rate-limited clients even without session throttle", () => {
    const { calls, reviews, handler } = registerRoutes({
        rateLimiters: {
            getReviewSubmissionRateLimitState: () => ({ blockedUntil: Date.now() + 60_000 }),
            registerReviewSubmissionAttempt: () => {
                throw new Error("blocked clients should not be registered again");
            },
        },
    });
    const req = createRequest({ rating: "5" }, {});
    const res = createResponse();

    handler(req, res);

    assert.equal(res.redirectedTo, "/#reviews");
    assert.equal(reviews.length, 0);
    assert.ok(calls.some((call) => call[0] === "flash" && /Veuillez patienter/.test(call[2])));
});

test("cart updates cannot target a product outside the matching cart item", () => {
    const mutations = [];
    const cartItem = { productId: 1, itemKey: "item-1", selectedOptions: [] };
    const { calls, handlers } = registerRoutes({
        cart: {
            getCartItems: () => [cartItem],
            upsertCartItem: (...args) => mutations.push(["upsert", ...args]),
            removeCartItem: (...args) => mutations.push(["remove", ...args]),
        },
        products: {
            getProductById: () => ({ id: 2, published: 1, inventory: 3 }),
        },
    });
    const req = createRequest({ item_key: "item-1", product_id: "2", quantity: "1" });

    handlers.get("/cart/update")(req, createResponse());

    assert.deepEqual(mutations, []);
    assert.ok(calls.some((call) => call[0] === "flash" && /correspond plus/.test(call[2])));
});

test("cart updates remove products that are no longer published", () => {
    const mutations = [];
    const cartItem = { productId: 1, itemKey: "item-1", selectedOptions: [] };
    const { calls, handlers } = registerRoutes({
        cart: {
            getCartItems: () => [cartItem],
            upsertCartItem: (...args) => mutations.push(["upsert", ...args]),
            removeCartItem: (_req, itemKey) => mutations.push(["remove", itemKey]),
        },
        products: {
            getProductById: () => ({ id: 1, published: 0, inventory: 3 }),
        },
    });
    const req = createRequest({ item_key: "item-1", product_id: "1", quantity: "1" });

    handlers.get("/cart/update")(req, createResponse());

    assert.deepEqual(mutations, [["remove", "item-1"]]);
    assert.ok(calls.some((call) => call[0] === "flash" && /n'est plus disponible/.test(call[2])));
});

test("cart updates reject partial and non-positive quantities", () => {
    for (const quantity of ["2items", "0", "-1"]) {
        const mutations = [];
        const cartItem = { productId: 1, itemKey: "item-1", selectedOptions: [] };
        const { calls, handlers } = registerRoutes({
            cart: {
                getCartItems: () => [cartItem],
                upsertCartItem: (...args) => mutations.push(args),
            },
            products: {
                getProductById: () => ({ id: 1, published: 1, inventory: 3 }),
            },
        });

        handlers.get("/cart/update")(
            createRequest({ item_key: "item-1", product_id: "1", quantity }),
            createResponse()
        );

        assert.deepEqual(mutations, []);
        assert.ok(calls.some((call) => call[0] === "flash" && /Quantité invalide/.test(call[2])));
    }
});
