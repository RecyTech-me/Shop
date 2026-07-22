const CHECKOUT_FIELD_LIMITS = Object.freeze({
    customer_email: 254,
    customer_first_name: 100,
    customer_last_name: 100,
    pickup_location: 64,
    shipping_country: 100,
    shipping_address1: 200,
    shipping_postal_code: 32,
    shipping_city: 100,
    shipping_region: 100,
    shipping_phone: 40,
    billing_country: 100,
    billing_first_name: 100,
    billing_last_name: 100,
    billing_address1: 200,
    billing_postal_code: 32,
    billing_city: 100,
    billing_region: 100,
    billing_phone: 40,
    promo_code: 64,
    order_note: 2000,
});

const CHECKOUT_TEXT_FIELDS = Object.freeze(
    Object.keys(CHECKOUT_FIELD_LIMITS).filter((field) => field !== "promo_code")
);

module.exports = { CHECKOUT_FIELD_LIMITS, CHECKOUT_TEXT_FIELDS };
