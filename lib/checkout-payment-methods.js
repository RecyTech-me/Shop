function createCheckoutPaymentMethodHelpers({ paymentState }) {
    function getAllowedPaymentMethods(deliveryMethod) {
        const methods = [];
        const state = paymentState();

        if (state.stripeEnabled) {
            methods.push("card");
        }

        methods.push("transfer");

        if (state.bitcoinEnabled) {
            methods.push("bitcoin");
        }

        if (deliveryMethod === "pickup") {
            methods.push("cash");
        }

        return methods;
    }

    function getPreferredPaymentMethod(deliveryMethod) {
        return getAllowedPaymentMethods(deliveryMethod)[0] || "transfer";
    }

    return {
        getAllowedPaymentMethods,
        getPreferredPaymentMethod,
    };
}

module.exports = { createCheckoutPaymentMethodHelpers };
