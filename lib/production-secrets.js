const KNOWN_PLACEHOLDER_VALUES = new Set([
    "change-this-session-secret",
    "change-this-order-view-secret",
    "change-me-now",
    "sk_test_your_secret_key",
    "pk_test_your_publishable_key",
    "whsec_your_webhook_secret",
    "your_swiss_bitcoin_pay_api_key",
    "choose_a_long_random_webhook_secret",
]);

function normalizeSecretValue(value) {
    return String(value || "").trim();
}

function isPlaceholderValue(value) {
    const normalized = normalizeSecretValue(value);
    const lower = normalized.toLowerCase();

    return KNOWN_PLACEHOLDER_VALUES.has(lower) ||
        /^change[-_ ]?(this|me)/i.test(normalized) ||
        /^your[-_ ]/i.test(normalized) ||
        /^choose[-_ ]?a[-_ ]?long/i.test(normalized);
}

function assertUsableProductionValue(name, value, options = {}) {
    const {
        minLength = 1,
        required = true,
    } = options;
    const normalized = normalizeSecretValue(value);

    if (!normalized) {
        if (required) {
            throw new Error(`Missing required production secret: ${name}`);
        }

        return "";
    }

    if (isPlaceholderValue(normalized)) {
        throw new Error(`Production secret ${name} still uses a placeholder value`);
    }

    if (normalized.length < minLength) {
        throw new Error(`Production secret ${name} must be at least ${minLength} characters long`);
    }

    return normalized;
}

module.exports = {
    assertUsableProductionValue,
    isPlaceholderValue,
    normalizeSecretValue,
};
