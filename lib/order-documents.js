const { A6_HEIGHT, A6_WIDTH, PdfDocument } = require("./pdf-document");
const { normalizeText } = require("./order-document-helpers");
const { drawShippingLabel } = require("./order-shipping-label");
const {
    drawDeliveryNote,
    drawInvoiceCompliance,
    drawInvoiceTotals,
    drawItemsTable,
    drawSignatureBlock,
} = require("./order-document-content");
const {
    drawCustomerBlocks,
    drawFooter,
    drawHeader,
    getDocumentNumberPrefix,
} = require("./order-document-layout");

function buildOrderDocumentContext(options) {
    const allowedTypes = new Set(["delivery-slip", "shipping-label"]);

    return {
        type: allowedTypes.has(options.type) ? options.type : "invoice",
        order: options.order,
        settings: options.settings || {},
        contact: options.contact || {},
        admin: options.admin || {},
        getOrderStatusLabel: options.getOrderStatusLabel,
        getOrderProviderLabel: options.getOrderProviderLabel,
        baseUrl: options.baseUrl || "",
        config: options.config || {},
    };
}

function drawOrderDocumentBody(state) {
    const separatorY = drawHeader(state.pdf, state.context);
    const customerBlocksBottomY = drawCustomerBlocks(state.pdf, state.context, separatorY - 24);

    state.y = customerBlocksBottomY - 28;
    drawItemsTable(state);

    if (state.context.type === "delivery-slip") {
        drawDeliveryNote(state);
        drawSignatureBlock(state);
        return;
    }

    drawInvoiceTotals(state);
    drawInvoiceCompliance(state);
}

function buildOrderDocumentPdf(options) {
    const isShippingLabel = options.type === "shipping-label";
    const pdf = new PdfDocument(isShippingLabel ? {
        width: A6_WIDTH,
        height: A6_HEIGHT,
    } : {});
    const state = {
        pdf,
        context: buildOrderDocumentContext(options),
        pageNumber: 1,
        y: 0,
    };

    if (isShippingLabel) {
        drawShippingLabel(pdf, state.context);
    } else {
        drawOrderDocumentBody(state);
        drawFooter(pdf, state.pageNumber, state.context);
    }

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
