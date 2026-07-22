const { COLORS } = require("./pdf-document");

const PAID_STATUSES = new Set(["paid", "processing", "ready_for_pickup", "shipped", "completed"]);
const BANK_TRANSFER_METHODS = new Set(["bank_transfer", "transfer"]);
const DEFAULT_IBAN_PLACEHOLDER = "CHXX XXXX XXXX XXXX XXXX X";
const PAYMENT_TERMS = "Payment within 30 days";
const VAT_NOTICE = "Entreprise non assujettie à la TVA selon l’art. 10 LTVA";

function normalizeText(value) {
    return String(value || "").trim();
}

function formatMoney(cents, currency = "CHF") {
    return new Intl.NumberFormat("fr-CH", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
    })
        .format((cents || 0) / 100)
        .replace(/['’]/g, " ");
}

function formatDocumentDate(value) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.valueOf())) {
        return "";
    }

    return new Intl.DateTimeFormat("fr-CH", {
        dateStyle: "long",
    }).format(parsed);
}

function splitAddressLines(value) {
    return String(value || "")
        .split(/\r?\n|,/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function normalizeComparisonLine(value) {
    return normalizeText(value)
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ");
}

function areSameAddressLines(firstLines, secondLines) {
    const first = (firstLines || []).map(normalizeComparisonLine).filter(Boolean);
    const second = (secondLines || []).map(normalizeComparisonLine).filter(Boolean);

    return first.length > 0 &&
        first.length === second.length &&
        first.every((line, index) => line === second[index]);
}

function addDays(value, days) {
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf())) {
        return null;
    }

    date.setDate(date.getDate() + days);
    return date;
}

function getPaymentTerms(order) {
    const dueDate = addDays(order.created_at, 30);
    return dueDate ? `${PAYMENT_TERMS} (${formatDocumentDate(dueDate)})` : PAYMENT_TERMS;
}

function isLocalUrl(value) {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(?::|\/|$)/i.test(normalizeText(value));
}

function getWebsiteUrl(context) {
    const url = normalizeText(context.settings?.website_url || context.config?.websiteUrl || context.baseUrl).replace(/\/$/, "");
    return isLocalUrl(url) ? "" : url;
}

function getTermsUrl(context) {
    const configuredUrl = normalizeText(context.config?.termsUrl || context.settings?.terms_url);
    if (configuredUrl && !isLocalUrl(configuredUrl)) {
        return configuredUrl;
    }

    const websiteUrl = getWebsiteUrl(context);
    return websiteUrl ? `${websiteUrl}/conditions-generales-de-vente` : "/conditions-generales-de-vente";
}

function getPaymentMethod(context) {
    const metadata = context.order.metadata || {};
    const rawMethod = normalizeText(
        metadata.checkout?.payment_method ||
        metadata.manual?.payment_method ||
        context.order.paymentMethod ||
        context.order.payment_method ||
        context.order.provider
    ).toLowerCase();

    return rawMethod === "transfer" ? "bank_transfer" : rawMethod;
}

function isBankTransferPayment(context) {
    const method = getPaymentMethod(context);
    const manualLabel = normalizeText(context.order.metadata?.manual?.payment_label).toLowerCase();
    return BANK_TRANSFER_METHODS.has(method) || /virement|bank transfer/.test(manualLabel);
}

function splitLongWord(word, maxChars) {
    if (word.length <= maxChars) {
        return [word];
    }

    const parts = [];
    for (let index = 0; index < word.length; index += maxChars) {
        parts.push(word.slice(index, index + maxChars));
    }
    return parts;
}

function wrapText(value, maxChars) {
    const lineLimit = Math.max(4, maxChars || 24);
    const words = normalizeText(value)
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((word) => splitLongWord(word, lineLimit));
    const lines = [];
    let current = "";

    for (const word of words) {
        if (!current) {
            current = word;
            continue;
        }

        if (`${current} ${word}`.length <= lineLimit) {
            current = `${current} ${word}`;
            continue;
        }

        lines.push(current);
        current = word;
    }

    if (current) {
        lines.push(current);
    }

    return lines.length ? lines : [""];
}

function truncateText(value, maxChars) {
    const textValue = normalizeText(value);
    if (textValue.length <= maxChars) {
        return textValue;
    }

    return `${textValue.slice(0, Math.max(1, maxChars - 1))}…`;
}

function shortenMiddle(value, maxChars) {
    const textValue = normalizeText(value);
    if (textValue.length <= maxChars) {
        return textValue;
    }

    const keep = Math.max(2, maxChars - 1);
    const start = Math.ceil(keep / 2);
    const end = Math.floor(keep / 2);
    return `${textValue.slice(0, start)}…${textValue.slice(-end)}`;
}

function drawWrappedText(pdf, text, x, y, options = {}) {
    const size = options.size || 10;
    const lineHeight = options.lineHeight || size + 3;
    const maxChars = Math.max(8, Math.floor((options.maxWidth || 120) / (size * 0.48)));
    const lines = wrapText(text, maxChars).slice(0, options.maxLines || 12);

    lines.forEach((line, index) => {
        pdf.text(line, x, y - (index * lineHeight), options);
    });

    return y - (lines.length * lineHeight);
}

function drawInfoBlock(pdf, title, textLines, x, topY, width, height) {
    pdf.rect(x, topY - height, width, height, {
        fill: COLORS.surface,
        stroke: COLORS.border,
    });
    pdf.text(title, x + 18, topY - 22, {
        font: "F2",
        size: 12,
    });

    textLines.forEach((line, index) => {
        pdf.text(line, x + 18, topY - 40 - (index * 12), {
            size: 9,
            color: COLORS.muted,
        });
    });
}

function getFallbackStatusLabel(status) {
    const labels = {
        pending: "En attente",
        awaiting_transfer: "En attente du virement",
        paid: "Payée",
        processing: "En préparation",
        ready_for_pickup: "Prête au retrait",
        shipped: "Expédiée",
        completed: "Terminée",
        cancelled: "Annulée",
        failed: "Échouée",
        refunded: "Remboursée",
    };

    return labels[status] || status;
}

module.exports = {
    DEFAULT_IBAN_PLACEHOLDER,
    PAID_STATUSES,
    VAT_NOTICE,
    areSameAddressLines,
    drawInfoBlock,
    drawWrappedText,
    formatDocumentDate,
    formatMoney,
    getFallbackStatusLabel,
    getPaymentTerms,
    getTermsUrl,
    getWebsiteUrl,
    isBankTransferPayment,
    normalizeText,
    shortenMiddle,
    splitAddressLines,
    truncateText,
    wrapText,
};
