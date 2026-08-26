const {
    A6_WIDTH,
    COLORS,
} = require("./pdf-document");
const {
    normalizeText,
    splitAddressLines,
    wrapText,
} = require("./order-document-helpers");
const { drawSvgLogo } = require("./svg-logo-renderer");

const LABEL_MARGIN = 20;
const LABEL_WIDTH = A6_WIDTH - (LABEL_MARGIN * 2);

function getSenderAddressLines(settings) {
    const configuredAddress = splitAddressLines(settings.support_address);
    if (configuredAddress.length) {
        return configuredAddress;
    }

    return [settings.store_address, settings.store_postal_city]
        .map(normalizeText)
        .filter(Boolean);
}

function getRecipientAddressLines(context) {
    const shippingLines = Array.isArray(context.contact.shippingLines)
        ? context.contact.shippingLines
        : [];
    const billingLines = Array.isArray(context.contact.billingLines)
        ? context.contact.billingLines
        : [];
    const addressLines = shippingLines.length ? shippingLines : billingLines;

    if (addressLines.length) {
        return addressLines.map(normalizeText).filter(Boolean);
    }

    return [normalizeText(context.order.customer_name) || "Adresse non renseignée"];
}

function prepareRecipientLines(context) {
    return getRecipientAddressLines(context)
        .flatMap((line, sourceIndex) => wrapText(line, 32).map((text) => ({
            text,
            bold: sourceIndex === 0,
        })));
}

function drawShippingLabel(pdf, context) {
    const { order, settings } = context;
    const shopName = normalizeText(settings.store_name) || "RecyTech";
    const senderAddress = getSenderAddressLines(settings).join(" - ");
    const senderLines = wrapText(`${shopName}${senderAddress ? ` - ${senderAddress}` : ""}`, 54);
    const recipientLines = prepareRecipientLines(context);
    const senderLineHeight = Math.min(10, 26 / senderLines.length);
    const senderFontSize = Math.min(7.5, senderLineHeight * 0.75);
    const recipientLineHeight = Math.min(28, 190 / recipientLines.length);
    const recipientFontSize = Math.min(16, recipientLineHeight * 0.62);

    pdf.rect(LABEL_MARGIN, 370, LABEL_WIDTH, 29, {
        fill: COLORS.green,
        stroke: COLORS.green,
    });
    drawSvgLogo(pdf, 27, 374, 21, 21);
    pdf.text("ÉTIQUETTE D'ADRESSE", 57, 380, {
        font: "F2",
        size: 11,
        color: COLORS.white,
    });

    pdf.text("EXPÉDITEUR", LABEL_MARGIN, 351, {
        font: "F2",
        size: 7,
        color: COLORS.muted,
    });
    senderLines.forEach((line, index) => {
        pdf.text(line, LABEL_MARGIN, 338 - (index * senderLineHeight), {
            size: senderFontSize,
            color: COLORS.green,
        });
    });
    pdf.line(LABEL_MARGIN, 311, LABEL_MARGIN + LABEL_WIDTH, 311, {
        color: COLORS.border,
    });

    pdf.text("DESTINATAIRE", LABEL_MARGIN, 290, {
        font: "F2",
        size: 8,
        color: COLORS.muted,
    });
    recipientLines.forEach((line, index) => {
        pdf.text(line.text, LABEL_MARGIN + 10, 258 - (index * recipientLineHeight), {
            font: line.bold ? "F2" : "F1",
            size: line.bold ? recipientFontSize + 1 : recipientFontSize,
            color: COLORS.green,
        });
    });

    pdf.line(LABEL_MARGIN, 54, LABEL_MARGIN + LABEL_WIDTH, 54, {
        color: COLORS.border,
    });
    pdf.text(`Commande : ${normalizeText(order.order_number)}`, LABEL_MARGIN, 39, {
        font: "F2",
        size: 8,
        color: COLORS.green,
    });
    pdf.text("À affranchir - aucun code-barres postal inclus", LABEL_MARGIN, 25, {
        size: 7,
        color: COLORS.muted,
    });
}

module.exports = {
    drawShippingLabel,
};
