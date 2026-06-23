function normalizeText(value) {
    return String(value || "").trim();
}

function normalizeSingleLineText(value) {
    return normalizeText(value).replace(/[\r\n]+/g, " ");
}

function truncateText(value, maxLength) {
    const text = normalizeText(value);
    return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function toBoolean(value) {
    return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseInteger(value, fallback) {
    const parsed = Number.parseInt(String(value || "").trim(), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseMoneyToCents(value, fallback = 0) {
    const normalized = String(value || "").trim().replace(",", ".");
    if (!normalized) {
        return fallback;
    }

    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.round(parsed * 100);
}

function parseOptionalMoneyToCents(value, fieldLabel) {
    const rawValue = String(value || "").trim();
    if (!rawValue) {
        return null;
    }

    const amountCents = parseMoneyToCents(rawValue, Number.NaN);
    if (!Number.isFinite(amountCents) || amountCents < 0) {
        throw new Error(`${fieldLabel} invalide.`);
    }

    return amountCents;
}

function normalizeDateField(value) {
    const normalized = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function normalizeOrderDateTimeField(value, fallback = "") {
    const normalized = normalizeText(value);
    if (!normalized) {
        return fallback;
    }

    const parsed = new Date(normalized);
    if (!Number.isFinite(parsed.valueOf())) {
        throw new Error("Date de commande invalide.");
    }

    return parsed.toISOString();
}

function formatDateTimeInputValue(value = new Date()) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.valueOf())) {
        return "";
    }

    return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

module.exports = {
    normalizeText,
    normalizeSingleLineText,
    truncateText,
    toBoolean,
    parseInteger,
    parseMoneyToCents,
    parseOptionalMoneyToCents,
    normalizeDateField,
    normalizeOrderDateTimeField,
    formatDateTimeInputValue,
};
