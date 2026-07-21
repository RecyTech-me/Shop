const crypto = require("crypto");

const CHECKOUT_ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function checkoutAttemptMatches(left, right) {
    if (!CHECKOUT_ATTEMPT_PATTERN.test(left) || !CHECKOUT_ATTEMPT_PATTERN.test(right)) {
        return false;
    }

    return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function createCheckoutSessionStateHelpers({
    getDefaultCheckoutForm,
    normalizeCheckoutFormState,
}) {
    function getCheckoutForm(req) {
        return normalizeCheckoutFormState({
            ...getDefaultCheckoutForm(),
            ...(req.session.checkoutForm || {}),
        });
    }

    function setCheckoutForm(req, values) {
        req.session.checkoutForm = values;
    }

    function clearCheckoutForm(req) {
        delete req.session.checkoutForm;
    }

    function getStripeDraft(req) {
        return req.session.stripeDraft || null;
    }

    function setStripeDraft(req, draft) {
        req.session.stripeDraft = draft;
    }

    function clearStripeDraft(req) {
        delete req.session.stripeDraft;
    }

    function getOrCreateCheckoutAttemptId(req) {
        const current = String(req.session.checkoutAttemptId || "");
        if (CHECKOUT_ATTEMPT_PATTERN.test(current)) {
            return current;
        }

        const completed = String(req.session.completedCheckoutAttempt?.id || "");
        if (CHECKOUT_ATTEMPT_PATTERN.test(completed)) {
            return completed;
        }

        const attemptId = crypto.randomBytes(24).toString("base64url");
        req.session.checkoutAttemptId = attemptId;
        return attemptId;
    }

    function requireCheckoutAttemptId(req, submittedAttemptId) {
        const submitted = String(submittedAttemptId || "").trim();
        const active = String(req.session.checkoutAttemptId || "");
        const completed = String(req.session.completedCheckoutAttempt?.id || "");

        if (!checkoutAttemptMatches(submitted, active) && !checkoutAttemptMatches(submitted, completed)) {
            throw new Error("Cette tentative de commande a expiré. Veuillez réessayer.");
        }

        return submitted;
    }

    function completeCheckoutAttempt(req, attemptId, orderId) {
        const active = String(req.session.checkoutAttemptId || "");
        if (!checkoutAttemptMatches(String(attemptId || ""), active)) {
            return;
        }

        req.session.completedCheckoutAttempt = {
            id: active,
            orderId,
            completedAt: new Date().toISOString(),
        };
        delete req.session.checkoutAttemptId;
    }

    function abandonCheckoutAttempt(req, attemptId) {
        const active = String(req.session.checkoutAttemptId || "");
        if (checkoutAttemptMatches(String(attemptId || ""), active)) {
            delete req.session.checkoutAttemptId;
        }
    }

    function getCompletedCheckoutOrderId(req, attemptId) {
        const completed = req.session.completedCheckoutAttempt;
        if (!checkoutAttemptMatches(String(attemptId || ""), String(completed?.id || ""))) {
            return null;
        }

        const orderId = Number.parseInt(completed.orderId, 10);
        return Number.isInteger(orderId) && orderId > 0 ? orderId : null;
    }

    return {
        abandonCheckoutAttempt,
        clearCheckoutForm,
        clearStripeDraft,
        getCheckoutForm,
        getCompletedCheckoutOrderId,
        getOrCreateCheckoutAttemptId,
        getStripeDraft,
        requireCheckoutAttemptId,
        completeCheckoutAttempt,
        setCheckoutForm,
        setStripeDraft,
    };
}

module.exports = { createCheckoutSessionStateHelpers };
