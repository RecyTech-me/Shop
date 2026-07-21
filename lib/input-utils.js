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
    const normalized = String(value ?? "").trim();
    if (!/^[+-]?\d+$/.test(normalized)) {
        return fallback;
    }

    const parsed = Number.parseInt(normalized, 10);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function parseMoneyToCents(value, fallback = 0) {
    const normalized = String(value ?? "").trim().replace(",", ".");
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
        return fallback;
    }

    const parsed = Number.parseFloat(normalized);
    const amountCents = Math.round(parsed * 100);
    return Number.isSafeInteger(amountCents) ? amountCents : fallback;
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
        return "";
    }

    const [year, month, day] = normalized.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() === month - 1
        && parsed.getUTCDate() === day
        ? normalized
        : "";
}

const SHOP_TIME_ZONE = "Europe/Zurich";
const SHOP_LOCAL_DATE_TIME_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const shopDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
});

function shopDateTimeParts(value) {
    return Object.fromEntries(
        shopDateTimeFormatter.formatToParts(value).map((part) => [part.type, part.value])
    );
}

function parseShopLocalDateTime(value) {
    const match = String(value || "").match(SHOP_LOCAL_DATE_TIME_PATTERN);
    if (!match) {
        return null;
    }

    const [, year, month, day, hour, minute, second = "00", millisecond = "0"] = match;
    const desired = {
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second),
        millisecond: Number(millisecond.padEnd(3, "0")),
    };
    const desiredUtc = Date.UTC(
        desired.year,
        desired.month - 1,
        desired.day,
        desired.hour,
        desired.minute,
        desired.second,
        desired.millisecond
    );
    const canonical = new Date(desiredUtc);
    if (
        canonical.getUTCFullYear() !== desired.year
        || canonical.getUTCMonth() !== desired.month - 1
        || canonical.getUTCDate() !== desired.day
        || canonical.getUTCHours() !== desired.hour
        || canonical.getUTCMinutes() !== desired.minute
        || canonical.getUTCSeconds() !== desired.second
    ) {
        return null;
    }

    let timestamp = desiredUtc;
    for (let iteration = 0; iteration < 3; iteration += 1) {
        const actual = shopDateTimeParts(new Date(timestamp));
        const actualAsUtc = Date.UTC(
            Number(actual.year),
            Number(actual.month) - 1,
            Number(actual.day),
            Number(actual.hour),
            Number(actual.minute),
            Number(actual.second),
            desired.millisecond
        );
        const adjustment = desiredUtc - actualAsUtc;
        timestamp += adjustment;
        if (!adjustment) {
            break;
        }
    }

    const parsed = new Date(timestamp);
    const verified = shopDateTimeParts(parsed);
    return Number(verified.year) === desired.year
        && Number(verified.month) === desired.month
        && Number(verified.day) === desired.day
        && Number(verified.hour) === desired.hour
        && Number(verified.minute) === desired.minute
        && Number(verified.second) === desired.second
        ? parsed
        : null;
}

function normalizeOrderDateTimeField(value, fallback = "") {
    const normalized = normalizeText(value);
    if (!normalized) {
        return fallback;
    }

    const parsed = SHOP_LOCAL_DATE_TIME_PATTERN.test(normalized)
        ? parseShopLocalDateTime(normalized)
        : new Date(normalized);
    if (!parsed || !Number.isFinite(parsed.valueOf())) {
        throw new Error("Date de commande invalide.");
    }

    return parsed.toISOString();
}

function formatDateTimeInputValue(value = new Date()) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.valueOf())) {
        return "";
    }

    const parts = shopDateTimeParts(parsed);
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

module.exports = {
    normalizeText,
    normalizeSingleLineText,
    truncateText,
    toBoolean,
    parseInteger,
    parseMoneyToCents,
    parseOptionalMoneyToCents,
    parseShopLocalDateTime,
    normalizeDateField,
    normalizeOrderDateTimeField,
    formatDateTimeInputValue,
};
