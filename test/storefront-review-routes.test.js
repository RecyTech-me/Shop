const assert = require("node:assert/strict");
const test = require("node:test");
const { registerStorefrontRoutes } = require("../routes/storefront");

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
        },
        products: {
            listPublishedProducts: () => [],
            listProductCategories: () => [],
            getProductBySlug: () => null,
            getProductById: () => null,
        },
        reviews: {
            listApprovedSiteReviews: () => [],
            getSiteReviewSummary: () => ({ count: 0, average: 0 }),
            createSiteReview: (_db, input) => {
                calls.push(["createSiteReview", input.rating]);
                reviews.push(input);
            },
        },
    };

    registerStorefrontRoutes(deps);

    return {
        calls,
        reviews,
        handler: handlers.get("/reviews"),
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
