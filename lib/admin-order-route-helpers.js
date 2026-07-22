const { ORDER_STATUS_OPTIONS } = require("./shop-formatters");

function buildOrderListViewModel({
    db,
    queryParams,
    normalizeText,
    listOrders,
    countOrders,
    limit = 50,
}) {
    const status = normalizeText(queryParams.status);
    const query = normalizeText(queryParams.q);
    const requestedPage = Math.max(1, Number.parseInt(queryParams.page, 10) || 1);
    const filters = {
        status: status || null,
        query: query || null,
    };
    const totalOrders = countOrders(db, filters);
    const totalPages = Math.max(1, Math.ceil(totalOrders / limit));
    const page = Math.min(requestedPage, totalPages);

    return {
        title: "Commandes",
        orders: listOrders(db, {
            ...filters,
            limit,
            offset: (page - 1) * limit,
        }),
        filters: {
            status,
            query,
        },
        pagination: {
            page,
            totalPages,
            totalOrders,
            hasPrevious: page > 1,
            hasNext: page < totalPages,
            previousPage: Math.max(1, page - 1),
            nextPage: Math.min(totalPages, page + 1),
        },
        orderStatusOptions: ORDER_STATUS_OPTIONS,
    };
}

function readOrderEmailRequest({
    values,
    order,
    settings,
    normalizeText,
    normalizeSingleLineText,
    getMailConfigError,
}) {
    if (!order.customer_email) {
        return {
            error: "Aucun e-mail client n'est renseigné pour cette commande.",
        };
    }

    const subject = normalizeSingleLineText(values.subject);
    const message = normalizeText(values.message);
    if (!subject || !message) {
        return {
            error: "Le sujet et le message sont obligatoires.",
        };
    }

    const configError = getMailConfigError(settings);
    if (configError) {
        return {
            error: `Envoi impossible : ${configError}`,
        };
    }

    return {
        message,
        subject,
    };
}

function applyOrderDocumentResponseHeaders(res, pdf, filename) {
    res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "Content-Length": String(pdf.length),
    });
}

module.exports = {
    applyOrderDocumentResponseHeaders,
    buildOrderListViewModel,
    readOrderEmailRequest,
};
