const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

async function loadStripeModule() {
    const source = fs.readFileSync(path.join(__dirname, "..", "public", "scripts", "checkout-stripe.js"));
    const moduleUrl = `data:text/javascript;base64,${source.toString("base64")}#${Date.now()}`;
    return import(moduleUrl);
}

function jsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
    };
}

function createElementStub(initial = {}) {
    const attributes = new Set();
    return {
        dataset: {},
        hidden: false,
        textContent: "",
        innerHTML: "",
        ...initial,
        setAttribute(name) {
            attributes.add(name);
        },
        removeAttribute(name) {
            attributes.delete(name);
        },
        hasAttribute(name) {
            return attributes.has(name);
        },
    };
}

test("Stripe controller message helper toggles visible error state", async () => {
    const { createStripeCheckoutController } = await loadStripeModule();
    const stripeMessage = createElementStub({ hidden: true, dataset: {} });
    const controller = createStripeCheckoutController({
        checkoutForm: null,
        cardPaymentSection: null,
        stripeMount: null,
        stripeMessage,
        csrfToken: "csrf",
        buildCheckoutDraftPayload: () => ({}),
    });

    controller.showMessage("Erreur Stripe", "info");
    assert.equal(stripeMessage.hidden, false);
    assert.equal(stripeMessage.textContent, "Erreur Stripe");
    assert.equal(stripeMessage.dataset.tone, "info");

    controller.showMessage("");
    assert.equal(stripeMessage.hidden, true);
    assert.equal(stripeMessage.textContent, "");
    assert.equal(stripeMessage.dataset.tone, "");
});

test("Stripe controller mounts payment element, prepares order, and confirms with billing details", async (t) => {
    const { createStripeCheckoutController } = await loadStripeModule();
    const originalFetch = global.fetch;
    const originalWindow = global.window;
    const originalDocument = global.document;
    const payload = {
        delivery_method: "ship",
        billing_same_as_shipping: "1",
        customer_email: "client@example.test",
        customer_first_name: "Client",
        customer_last_name: "Test",
        shipping_phone: "+41 32 000 00 00",
        shipping_address1: "Rue du Test 1",
        shipping_postal_code: "2000",
        shipping_city: "Neuchâtel",
        shipping_region: "NE",
        billing_phone: "ignored",
        billing_address1: "ignored",
        billing_postal_code: "ignored",
        billing_city: "ignored",
        billing_region: "ignored",
    };
    const fetchCalls = [];
    const events = [];
    let stripeKey = "";
    let elementsOptions = null;
    let paymentElementOptions = null;
    let mountedSelector = "";
    let confirmParams = null;
    let assignedLocation = "";

    t.after(() => {
        global.fetch = originalFetch;
        global.window = originalWindow;
        global.document = originalDocument;
    });

    global.fetch = async (url, options) => {
        events.push(`fetch:${url}`);
        fetchCalls.push({
            url,
            options,
            body: JSON.parse(options.body || "{}"),
        });

        if (url === "/stripe/intent") {
            return jsonResponse(200, {
                paymentIntentId: "pi_test_123",
                clientSecret: "pi_test_secret_123",
            });
        }

        if (url === "/stripe/prepare") {
            return jsonResponse(200, {
                successUrl: "/checkout/success?order=RT-1",
            });
        }

        return jsonResponse(404, {});
    };

    global.window = {
        Stripe: (key) => {
            stripeKey = key;
            return {
                elements: (options) => {
                    elementsOptions = options;
                    return {
                        create: (type, optionsForElement) => {
                            paymentElementOptions = { type, options: optionsForElement };
                            return {
                                mount: (selector) => {
                                    mountedSelector = selector;
                                },
                                unmount: () => {},
                            };
                        },
                        submit: async () => {
                            events.push("stripe:submit");
                            return {};
                        },
                    };
                },
                confirmPayment: async (params) => {
                    events.push("stripe:confirmPayment");
                    confirmParams = params;
                    return {};
                },
            };
        },
        location: {
            assign: (url) => {
                assignedLocation = url;
            },
        },
    };
    global.document = {
        querySelector: (selector) => {
            const values = {
                'input[name="customer_email"]': payload.customer_email,
                'input[name="customer_first_name"]': payload.customer_first_name,
                'input[name="customer_last_name"]': payload.customer_last_name,
            };

            return Object.hasOwn(values, selector) ? { value: values[selector] } : null;
        },
    };

    const submitButton = createElementStub();
    const checkoutForm = createElementStub({
        dataset: {
            stripePublishableKey: "pk_test_123",
            stripeIntentUrl: "/stripe/intent",
            stripePrepareUrl: "/stripe/prepare",
        },
        reportValidity: () => true,
        querySelector: (selector) => selector === 'button[type="submit"]' ? submitButton : null,
    });
    const stripeMessage = createElementStub({ hidden: true, dataset: {} });
    const controller = createStripeCheckoutController({
        checkoutForm,
        cardPaymentSection: createElementStub({ hidden: false }),
        stripeMount: createElementStub({ innerHTML: "placeholder" }),
        stripeMessage,
        csrfToken: "csrf-token",
        buildCheckoutDraftPayload: () => ({ ...payload }),
        beforeSubmit: async () => events.push("draft:flush"),
    });

    await controller.submitCheckout({
        preventDefault: () => {},
    });

    assert.equal(stripeKey, "pk_test_123");
    assert.equal(elementsOptions.clientSecret, "pi_test_secret_123");
    assert.equal(paymentElementOptions.type, "payment");
    assert.equal(paymentElementOptions.options.defaultValues.billingDetails.email, "client@example.test");
    assert.equal(paymentElementOptions.options.defaultValues.billingDetails.name, "Client Test");
    assert.equal(mountedSelector, "#stripe-payment-element");
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].options.headers["X-CSRF-Token"], "csrf-token");
    assert.equal(fetchCalls[1].body.stripe_payment_intent_id, "pi_test_123");
    assert.deepEqual(events, [
        "draft:flush",
        "fetch:/stripe/intent",
        "stripe:submit",
        "fetch:/stripe/prepare",
        "stripe:confirmPayment",
    ]);
    assert.deepEqual(confirmParams.confirmParams.payment_method_data.billing_details, {
        email: "client@example.test",
        name: "Client Test",
        phone: "+41 32 000 00 00",
        address: {
            country: "CH",
            line1: "Rue du Test 1",
            postal_code: "2000",
            city: "Neuchâtel",
            state: "NE",
        },
    });
    assert.equal(assignedLocation, "/checkout/success?order=RT-1");
    assert.equal(stripeMessage.hidden, true);
    assert.equal(submitButton.hasAttribute("disabled"), true);
});

test("Stripe controller does not prepare an order when Stripe Elements submit fails", async (t) => {
    const { createStripeCheckoutController } = await loadStripeModule();
    const originalFetch = global.fetch;
    const originalWindow = global.window;
    const originalDocument = global.document;
    const fetchCalls = [];
    let resumedDraftSaving = false;

    t.after(() => {
        global.fetch = originalFetch;
        global.window = originalWindow;
        global.document = originalDocument;
    });

    global.fetch = async (url, options) => {
        fetchCalls.push({ url, options });
        if (url === "/stripe/intent") {
            return jsonResponse(200, {
                paymentIntentId: "pi_test_123",
                clientSecret: "pi_test_secret_123",
            });
        }

        return jsonResponse(500, {});
    };
    global.window = {
        Stripe: () => ({
            elements: () => ({
                create: () => ({
                    mount: () => {},
                    unmount: () => {},
                }),
                submit: async () => ({
                    error: new Error("Carte incomplète"),
                }),
            }),
            confirmPayment: async () => {
                throw new Error("confirmPayment should not run");
            },
        }),
        location: {
            assign: () => {
                throw new Error("redirect should not run");
            },
        },
    };
    global.document = {
        querySelector: () => null,
    };

    const submitButton = createElementStub();
    const stripeMessage = createElementStub({ hidden: true, dataset: {} });
    const controller = createStripeCheckoutController({
        checkoutForm: createElementStub({
            dataset: {
                stripePublishableKey: "pk_test_123",
                stripeIntentUrl: "/stripe/intent",
                stripePrepareUrl: "/stripe/prepare",
            },
            reportValidity: () => true,
            querySelector: (selector) => selector === 'button[type="submit"]' ? submitButton : null,
        }),
        cardPaymentSection: createElementStub({ hidden: false }),
        stripeMount: createElementStub(),
        stripeMessage,
        csrfToken: "csrf-token",
        buildCheckoutDraftPayload: () => ({}),
        afterSubmitFailure: () => {
            resumedDraftSaving = true;
        },
    });

    await controller.submitCheckout({
        preventDefault: () => {},
    });

    assert.deepEqual(fetchCalls.map((call) => call.url), ["/stripe/intent"]);
    assert.equal(stripeMessage.hidden, false);
    assert.equal(stripeMessage.textContent, "Carte incomplète");
    assert.equal(submitButton.hasAttribute("disabled"), false);
    assert.equal(resumedDraftSaving, true);
});

test("Stripe controller serializes and deduplicates forced intent refreshes", async (t) => {
    const { createStripeCheckoutController } = await loadStripeModule();
    const originalFetch = global.fetch;
    const originalWindow = global.window;
    const originalDocument = global.document;
    const pendingResponses = [];
    let fetchCount = 0;

    t.after(() => {
        global.fetch = originalFetch;
        global.window = originalWindow;
        global.document = originalDocument;
    });

    global.fetch = () => {
        fetchCount += 1;
        return new Promise((resolve) => pendingResponses.push(resolve));
    };
    global.window = {
        Stripe: () => ({
            elements: () => ({
                create: () => ({ mount() {}, unmount() {} }),
            }),
        }),
    };
    global.document = { querySelector: () => null };

    const controller = createStripeCheckoutController({
        checkoutForm: createElementStub({
            dataset: {
                stripePublishableKey: "pk_test_123",
                stripeIntentUrl: "/stripe/intent",
            },
        }),
        cardPaymentSection: createElementStub({ hidden: false }),
        stripeMount: createElementStub(),
        stripeMessage: createElementStub({ dataset: {} }),
        csrfToken: "csrf",
        buildCheckoutDraftPayload: () => ({ delivery_method: "pickup" }),
    });

    const initialMount = controller.mountPaymentElement();
    const firstRefresh = controller.mountPaymentElement(true);
    const duplicateRefresh = controller.mountPaymentElement(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchCount, 1);

    pendingResponses.shift()(jsonResponse(200, {
        paymentIntentId: "pi_initial",
        clientSecret: "secret_initial",
    }));
    await initialMount;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchCount, 2);

    pendingResponses.shift()(jsonResponse(200, {
        paymentIntentId: "pi_refresh",
        clientSecret: "secret_refresh",
    }));
    await Promise.all([firstRefresh, duplicateRefresh]);

    assert.equal(fetchCount, 2);
});
