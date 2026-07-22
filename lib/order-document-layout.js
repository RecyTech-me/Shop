const {
    COLORS,
    PAGE_MARGIN,
} = require("./pdf-document");
const { drawSvgLogo } = require("./svg-logo-renderer");
const {
    areSameAddressLines,
    drawInfoBlock,
    drawWrappedText,
    formatDocumentDate,
    getFallbackStatusLabel,
    getTermsUrl,
    getWebsiteUrl,
    normalizeText,
    splitAddressLines,
    wrapText,
} = require("./order-document-helpers");

function getDocumentTitle(type) {
    return type === "delivery-slip" ? "Bon de livraison" : "Facture";
}

function getDocumentNumberPrefix(type) {
    return type === "delivery-slip" ? "BL" : "F";
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

module.exports = {
    drawCustomerBlocks,
    drawFooter,
    drawHeader,
    ensurePageSpace,
    getDocumentNumberPrefix,
    getDocumentTitle,
};
