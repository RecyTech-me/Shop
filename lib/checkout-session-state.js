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

    return {
        clearCheckoutForm,
        clearStripeDraft,
        getCheckoutForm,
        getStripeDraft,
        setCheckoutForm,
        setStripeDraft,
    };
}

module.exports = { createCheckoutSessionStateHelpers };
