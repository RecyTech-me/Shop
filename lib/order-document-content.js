const {
    COLORS,
    PAGE_MARGIN,
} = require("./pdf-document");
const {
    DEFAULT_IBAN_PLACEHOLDER,
    PAID_STATUSES,
    VAT_NOTICE,
    drawWrappedText,
    formatMoney,
    getPaymentTerms,
    isBankTransferPayment,
    normalizeText,
    shortenMiddle,
    truncateText,
    wrapText,
} = require("./order-document-helpers");
const { ensurePageSpace } = require("./order-document-layout");

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

module.exports = {
    drawDeliveryNote,
    drawInvoiceCompliance,
    drawInvoiceTotals,
    drawItemsTable,
    drawSignatureBlock,
};
