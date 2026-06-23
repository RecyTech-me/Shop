const {
    COLORS,
    PAGE_MARGIN,
    PdfDocument,
} = require("./pdf-document");
const { drawSvgLogo } = require("./svg-logo-renderer");

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
    }).format((cents || 0) / 100);
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


function getOrderSubtotal(order) {
    return (order.items || []).reduce((total, item) => {
        const lineTotal = Number.isFinite(item.line_total_cents)
            ? item.line_total_cents
            : (item.unit_price_cents || 0) * (item.quantity || 0);
        return total + lineTotal;
    }, 0);
}

function getAdditions(order) {
    return Array.isArray(order.metadata?.additions)
        ? order.metadata.additions.filter((line) => Number.isFinite(line?.amount_cents))
        : [];
}

function getAdditionDocumentLabel(line) {
    if (line?.type === "discount") {
        return "Remise";
    }

    if (line?.type === "shipping") {
        return "Livraison";
    }

    return shortenMiddle(line?.label || "Ajustement", 16);
}

function getDocumentTitle(type) {
    return type === "delivery-slip" ? "Bon de livraison" : "Facture";
}

function getDocumentNumberPrefix(type) {
    return type === "delivery-slip" ? "BL" : "F";
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

function drawHeader(pdf, context) {
    const { order, settings, type } = context;
    const documentTitle = getDocumentTitle(type);
    const documentNumber = `${getDocumentNumberPrefix(type)}-${order.order_number}`;
    const shopName = normalizeText(settings.store_name) || "RecyTech Shop";
    const shopAddressLines = splitAddressLines(settings.support_address);
    const supportEmail = normalizeText(settings.support_email);

    pdf.rect(PAGE_MARGIN, 718, 511, 78, {
        fill: COLORS.surface,
        stroke: COLORS.border,
    });
    drawSvgLogo(pdf, 50, 738, 38, 38);
    pdf.text(shopName, 94, 760, {
        font: "F2",
        size: 18,
    });
    pdf.text("Matériel reconditionné", 94, 742, {
        size: 10,
        color: COLORS.muted,
    });

    const headerLines = [...shopAddressLines, supportEmail, settings.support_phone, getWebsiteUrl(context)].filter(Boolean).slice(0, 5);
    const headerLineHeight = 11;
    const headerBlockHeight = headerLines.length ? ((headerLines.length - 1) * headerLineHeight) + 8.5 : 0;
    let rightY = 718 + ((78 + headerBlockHeight) / 2) - 8.5;
    for (const line of headerLines) {
        pdf.text(line, 365, rightY, {
            size: 8.5,
            color: COLORS.muted,
        });
        rightY -= headerLineHeight;
    }

    pdf.text(documentTitle.toUpperCase(), PAGE_MARGIN, 672, {
        font: "F2",
        size: 30,
    });
    const metaY = drawWrappedText(pdf, documentNumber, PAGE_MARGIN, 650, {
        size: 11,
        color: COLORS.muted,
        maxWidth: 285,
        lineHeight: 12,
    }) - 6;
    const separatorY = drawDocumentMeta(pdf, context, PAGE_MARGIN, metaY, 285) - 10;
    pdf.line(PAGE_MARGIN, separatorY, 553, separatorY, {
        color: COLORS.green,
        lineWidth: 1.4,
    });

    return separatorY;
}


function drawFooter(pdf, pageNumber, context = {}) {
    const legalUrl = getTermsUrl(context);

    pdf.line(PAGE_MARGIN, 56, 553, 56, {
        color: COLORS.border,
    });
    pdf.text("Thank you for your business", PAGE_MARGIN, 46, {
        font: "F2",
        size: 8,
        color: COLORS.muted,
    });
    pdf.text(`Conditions générales de vente : ${legalUrl}`, PAGE_MARGIN, 32, {
        size: 8,
        color: COLORS.muted,
    });
    pdf.text(`Page ${pageNumber}`, 520, 32, {
        size: 8,
        color: COLORS.muted,
    });
}

function drawCompactHeader(pdf, context) {
    pdf.text(`${getDocumentTitle(context.type)} ${getDocumentNumberPrefix(context.type)}-${context.order.order_number}`, PAGE_MARGIN, 790, {
        font: "F2",
        size: 14,
    });
    pdf.line(PAGE_MARGIN, 774, 553, 774, {
        color: COLORS.green,
    });
}

function ensurePageSpace(state, neededHeight) {
    if (state.y - neededHeight >= 86) {
        return;
    }

    drawFooter(state.pdf, state.pageNumber, state.context);
    state.pdf.addPage();
    state.pageNumber += 1;
    drawCompactHeader(state.pdf, state.context);
    state.y = 742;
}

function prepareInfoBlockLines(lines, width) {
    const maxChars = Math.floor((width - 36) / (9 * 0.48));
    return lines.filter(Boolean).flatMap((line) => wrapText(line, maxChars));
}

function getInfoBlockHeight(lineCount) {
    return Math.max(76, 58 + (Math.max(1, lineCount) - 1) * 12);
}

function drawCustomerBlocks(pdf, context, topY) {
    const { contact, order, admin } = context;
    const billingLines = contact.billingLines?.length
        ? contact.billingLines
        : contact.shippingLines || [];
    const shippingLines = contact.shippingLines?.length
        ? contact.shippingLines
        : billingLines;
    const customerLines = [
        ...billingLines,
        order.customer_email,
        contact.phone,
    ].filter(Boolean);
    const delivery = order.metadata?.delivery || {};
    const fulfillmentLines = [
        delivery.label ? `Mode : ${delivery.label}` : null,
        admin?.carrier ? `Transporteur : ${admin.carrier}` : null,
        admin?.tracking_number ? `Suivi : ${admin.tracking_number}` : null,
        admin?.pickup_details ? `Retrait : ${admin.pickup_details}` : null,
    ].filter(Boolean);
    const hasDistinctShippingAddress = !areSameAddressLines(shippingLines, billingLines);
    const visibleCustomerLines = hasDistinctShippingAddress
        ? customerLines
        : [...customerLines, ...fulfillmentLines];

    if (!hasDistinctShippingAddress) {
        const customerTextLines = prepareInfoBlockLines(visibleCustomerLines.length ? visibleCustomerLines : [order.customer_name], 511);
        const height = getInfoBlockHeight(customerTextLines.length);
        drawInfoBlock(pdf, "Client", customerTextLines, PAGE_MARGIN, topY, 511, height);
        return topY - height;
    }

    const customerTextLines = prepareInfoBlockLines(customerLines.length ? customerLines : [order.customer_name], 242);
    const deliveryTextLines = prepareInfoBlockLines([...shippingLines, ...fulfillmentLines].filter(Boolean), 242);
    const height = getInfoBlockHeight(Math.max(customerTextLines.length, deliveryTextLines.length));

    drawInfoBlock(pdf, "Client", customerTextLines, PAGE_MARGIN, topY, 242, height);
    drawInfoBlock(pdf, "Livraison", deliveryTextLines, 311, topY, 242, height);

    return topY - height;
}


function drawDocumentMeta(pdf, context, x, y, maxWidth) {
    const { order, type, getOrderStatusLabel, getOrderProviderLabel } = context;
    const statusLabel = getOrderStatusLabel ? getOrderStatusLabel(order.status) : getFallbackStatusLabel(order.status);
    const providerLabel = getOrderProviderLabel ? getOrderProviderLabel(order.provider) : order.provider;
    const isInvoice = type !== "delivery-slip";
    const metaLines = [
        `${isInvoice ? "Date de facture" : "Date du bon"} : ${formatDocumentDate(order.created_at)}`,
        `Statut : ${statusLabel}`,
        isInvoice ? `Paiement : ${providerLabel}` : null,
    ].filter(Boolean);

    let currentY = y;
    for (const line of metaLines) {
        currentY = drawWrappedText(pdf, line, x, currentY, {
            size: 9,
            color: COLORS.muted,
            maxWidth,
            lineHeight: 11,
        }) - 2;
    }

    return currentY;
}


function drawTableHeader(pdf, type, y) {
    pdf.rect(PAGE_MARGIN, y - 24, 511, 26, {
        fill: COLORS.green,
        stroke: COLORS.green,
    });
    pdf.text("Article", 54, y - 15, {
        font: "F2",
        size: 9,
        color: COLORS.white,
    });
    pdf.text("Qté", type === "delivery-slip" ? 486 : 318, y - 15, {
        font: "F2",
        size: 9,
        color: COLORS.white,
    });

    if (type !== "delivery-slip") {
        pdf.text("Prix unit.", 374, y - 15, {
            font: "F2",
            size: 9,
            color: COLORS.white,
        });
        pdf.text("Total", 487, y - 15, {
            font: "F2",
            size: 9,
            color: COLORS.white,
        });
    }
}

function formatItemOptions(item) {
    return Array.isArray(item.selected_options) && item.selected_options.length
        ? item.selected_options.map((option) => `${option.name}: ${option.value}`).join(" · ")
        : "";
}

function drawItemRow(state, item, index) {
    const { pdf, context } = state;
    const isDeliverySlip = context.type === "delivery-slip";
    const optionsText = formatItemOptions(item);
    const lineTotal = Number.isFinite(item.line_total_cents)
        ? item.line_total_cents
        : (item.unit_price_cents || 0) * (item.quantity || 0);
    const productWidth = isDeliverySlip ? 330 : 245;
    const lineLimit = Math.floor(productWidth / 5.2);
    const lines = wrapText(item.name, lineLimit);

    if (optionsText) {
        lines.push(...wrapText(optionsText, lineLimit));
    }

    const rowHeight = Math.max(46, 22 + (lines.length * 12));

    ensurePageSpace(state, rowHeight + 10);

    pdf.rect(PAGE_MARGIN, state.y - rowHeight, 511, rowHeight, {
        fill: index % 2 === 0 ? COLORS.surface : COLORS.surfaceAlt,
        stroke: COLORS.border,
    });

    lines.forEach((line, lineIndex) => {
        pdf.text(line, 54, state.y - 20 - (lineIndex * 12), {
            font: lineIndex === 0 ? "F2" : "F1",
            size: 9,
            color: lineIndex === 0 ? COLORS.green : COLORS.muted,
        });
    });

    pdf.text(String(item.quantity || 0), isDeliverySlip ? 492 : 324, state.y - 20, {
        size: 9,
        color: COLORS.green,
    });

    if (!isDeliverySlip) {
        pdf.text(formatMoney(item.unit_price_cents || 0, context.order.currency), 374, state.y - 20, {
            size: 9,
            color: COLORS.green,
        });
        pdf.text(formatMoney(lineTotal, context.order.currency), 486, state.y - 20, {
            size: 9,
            color: COLORS.green,
        });
    }

    state.y -= rowHeight;
}


function drawItemsTable(state) {
    const items = Array.isArray(state.context.order.items) ? state.context.order.items : [];

    drawTableHeader(state.pdf, state.context.type, state.y);
    state.y -= 26;

    if (!items.length) {
        drawItemRow(state, {
            name: "Aucun article",
            quantity: 0,
            unit_price_cents: 0,
            line_total_cents: 0,
            selected_options: [],
        }, 0);
        return;
    }

    items.forEach((item, index) => drawItemRow(state, item, index));
}

function drawInvoiceTotals(state) {
    const { pdf, context } = state;
    const { order } = context;
    const additions = getAdditions(order);
    const rows = [
        ["Sous-total", getOrderSubtotal(order)],
        ...additions.map((line) => [getAdditionDocumentLabel(line), line.amount_cents || 0]),
        ["Total", order.amount_cents || 0],
    ];
    const paidLabel = PAID_STATUSES.has(order.status) ? "Payé" : "À payer";

    const boxHeight = 50 + (rows.length * 18);
    ensurePageSpace(state, boxHeight + 30);
    state.y -= 18;
    const topY = state.y;
    pdf.rect(332, topY - boxHeight, 221, boxHeight, {
        fill: COLORS.surface,
        stroke: COLORS.border,
    });

    const rowLineHeight = 18;
    const statusGap = 22;
    const statusLineHeight = 9;
    const contentHeight = (rows.length * rowLineHeight) + statusGap + statusLineHeight;
    let y = topY - ((boxHeight - contentHeight) / 2) - 15;
    rows.forEach(([label, amount], index) => {
        const isTotal = index === rows.length - 1;
        pdf.text(truncateText(label, 16), 350, y, {
            font: isTotal ? "F2" : "F1",
            size: isTotal ? 12 : 10,
            color: COLORS.green,
        });
        pdf.text(formatMoney(amount, order.currency), 458, y, {
            font: isTotal ? "F2" : "F1",
            size: isTotal ? 12 : 10,
            color: COLORS.green,
        });
        y -= rowLineHeight;
    });

    pdf.text(paidLabel, 350, y - (statusGap - rowLineHeight), {
        font: "F2",
        size: 9,
        color: COLORS.muted,
    });
    state.lastTotalsBox = {
        topY,
        boxHeight,
        bottomY: topY - boxHeight,
    };
    state.y = y - 46;
}

function drawQrBillPlaceholder(pdf, x, y, size) {
    pdf.rect(x, y, size, size, {
        fill: COLORS.surfaceAlt,
        stroke: COLORS.border,
    });
    pdf.line(x + 12, y + 12, x + size - 12, y + size - 12, {
        color: COLORS.border,
    });
    pdf.line(x + size - 12, y + 12, x + 12, y + size - 12, {
        color: COLORS.border,
    });
    pdf.text("Swiss QR-bill", x + 14, y + (size / 2) + 4, {
        font: "F2",
        size: 8,
        color: COLORS.muted,
    });
    pdf.text("placeholder", x + 18, y + (size / 2) - 9, {
        size: 8,
        color: COLORS.muted,
    });
}

function drawPaymentDetails(state) {
    const { pdf, context } = state;
    const { settings } = context;
    const totalsBox = state.lastTotalsBox;
    const sideBySide = totalsBox && totalsBox.bottomY >= 116;
    const boxHeight = sideBySide ? totalsBox.boxHeight : 118;
    const boxWidth = sideBySide ? 270 : 511;
    const boxX = PAGE_MARGIN;
    const topY = sideBySide ? totalsBox.topY : state.y - 8;
    const qrSize = sideBySide ? 54 : 72;
    const qrX = boxX + boxWidth - qrSize - 18;
    const qrY = topY - boxHeight + 18;
    const iban = normalizeText(settings.bank_iban) || DEFAULT_IBAN_PLACEHOLDER;
    const accountHolder = normalizeText(settings.bank_account_holder) || normalizeText(settings.store_name) || "RecyTech";
    const bankName = normalizeText(settings.bank_name) || "Banque à définir";
    const lines = [
        `IBAN : ${iban}`,
        `Account holder name : ${accountHolder}`,
        `Bank name : ${bankName}`,
    ];

    if (!sideBySide) {
        ensurePageSpace(state, boxHeight + 18);
    }

    pdf.rect(boxX, topY - boxHeight, boxWidth, boxHeight, {
        fill: COLORS.surface,
        stroke: COLORS.border,
    });
    pdf.text("Payment details", boxX + 18, topY - 24, {
        font: "F2",
        size: 12,
    });

    lines.forEach((line, index) => {
        pdf.text(line, boxX + 18, topY - 47 - (index * 13), {
            size: 8,
            color: COLORS.muted,
        });
    });

    drawQrBillPlaceholder(pdf, qrX, qrY, qrSize);
    state.y = Math.min(state.y, topY - boxHeight) - 8;
}

function drawInvoiceCompliance(state) {
    const { pdf, context } = state;

    if (isBankTransferPayment(context)) {
        drawPaymentDetails(state);
    }

    ensurePageSpace(state, 58);
    state.y -= 10;
    pdf.text(getPaymentTerms(context.order), PAGE_MARGIN, state.y, {
        font: "F2",
        size: 10,
    });
    state.y = drawWrappedText(pdf, VAT_NOTICE, PAGE_MARGIN, state.y - 16, {
        size: 9,
        color: COLORS.muted,
        maxWidth: 500,
        lineHeight: 12,
        maxLines: 3,
    }) - 6;
}

function drawDeliveryNote(state) {
    const { pdf, context } = state;
    const note = context.admin?.fulfillment_note || context.admin?.customer_note || "";

    if (!note) {
        return;
    }

    ensurePageSpace(state, 72);
    state.y -= 22;
    pdf.text("Note de livraison", PAGE_MARGIN, state.y, {
        font: "F2",
        size: 12,
    });
    state.y = drawWrappedText(pdf, note, PAGE_MARGIN, state.y - 18, {
        size: 9,
        color: COLORS.muted,
        maxWidth: 500,
        lineHeight: 12,
        maxLines: 6,
    });
}

function drawSignatureBlock(state) {
    const { pdf } = state;
    ensurePageSpace(state, 80);
    state.y -= 28;
    pdf.text("Remis / reçu par", PAGE_MARGIN, state.y, {
        font: "F2",
        size: 10,
    });
    pdf.line(PAGE_MARGIN, state.y - 36, 260, state.y - 36, {
        color: COLORS.border,
    });
    pdf.text("Signature", PAGE_MARGIN, state.y - 52, {
        size: 8,
        color: COLORS.muted,
    });
}

function buildOrderDocumentPdf(options) {
    const context = {
        type: options.type === "delivery-slip" ? "delivery-slip" : "invoice",
        order: options.order,
        settings: options.settings || {},
        contact: options.contact || {},
        admin: options.admin || {},
        getOrderStatusLabel: options.getOrderStatusLabel,
        getOrderProviderLabel: options.getOrderProviderLabel,
        baseUrl: options.baseUrl || "",
        config: options.config || {},
    };
    const pdf = new PdfDocument();
    const state = {
        pdf,
        context,
        pageNumber: 1,
        y: 0,
    };

    const separatorY = drawHeader(pdf, context);
    const customerBlocksBottomY = drawCustomerBlocks(pdf, context, separatorY - 24);

    state.y = customerBlocksBottomY - 28;
    drawItemsTable(state);

    if (context.type === "delivery-slip") {
        drawDeliveryNote(state);
        drawSignatureBlock(state);
    } else {
        drawInvoiceTotals(state);
        drawInvoiceCompliance(state);
    }

    drawFooter(pdf, state.pageNumber, context);

    return pdf.build();
}

function buildOrderDocumentFilename(order, type) {
    const prefix = getDocumentNumberPrefix(type);
    const orderNumber = normalizeText(order?.order_number).replace(/[^a-z0-9_-]/gi, "-") || "commande";
    return `${prefix}-${orderNumber}.pdf`;
}

module.exports = {
    buildOrderDocumentPdf,
    buildOrderDocumentFilename,
};
