const { buildOrderDocumentPdf, buildOrderDocumentFilename } = require("../../lib/order-documents");
const { createManualOrderService } = require("../../lib/manual-order-service");
const { createOrderUpdateService } = require("../../lib/order-update-service");
const {
    applyOrderDocumentResponseHeaders,
    buildOrderListViewModel,
    readOrderEmailRequest,
} = require("../../lib/admin-order-route-helpers");
const {
    ORDER_STATUS_OPTIONS,
    getOrderStatusLabel,
    getOrderProviderLabel,
} = require("../../lib/shop-formatters");

function registerAdminOrderRoutes(deps) {
    const {
        app,
        db,
        http,
        text,
        money,
        forms,
        publicProducts,
        cart,
        checkout,
        urls,
        settings,
        products,
        promos,
        orders,
        mail,
    } = deps;
    const { requireAdmin, render, setFlash, saveSessionAndRedirect } = http;
    const { normalizeText, normalizeSingleLineText } = text;
    const { parseMoneyToCents, parseOptionalMoneyToCents, normalizeOrderDateTimeField } = money;
    const { readSelectedProductOptions } = forms;
    const { productCategoryList } = publicProducts;
    const {
        ensureAvailableProductQuantity,
        validateRequestedServiceTags,
        getProductUnitPriceCents,
        getConfigurationAvailableQuantity,
        snapshotPackBundleItems,
    } = cart;
    const { normalizePromoCode, getPromoCodeOutcome, getPromoCodeLabel } = checkout;
    const { baseUrl, getOrderDocumentConfig } = urls;
    const { getSettings } = settings;
    const { listAdminProducts, getProductById } = products;
    const { listPromoCodes } = promos;
    const {
        getOrderContactSnapshot,
        getOrderAdminData,
        buildOrderMailto,
        canEditOrderReceivedAmount,
        readReceivedPaymentInput,
        getOrderPaymentData,
        createOrder,
        getOrderById,
        updateOrderRecord,
        markOrderPaid,
        listOrders,
        countOrders,
        deleteOrder,
    } = orders;
    const {
        buildOrderEmailDraft,
        isMailConfigured,
        getMailConfigError,
        sendStoreEmail,
    } = mail;

    const manualOrderService = createManualOrderService({
        db,
        normalizeText,
        normalizeSingleLineText,
        parseMoneyToCents,
        parseOptionalMoneyToCents,
        normalizeOrderDateTimeField,
        normalizePromoCode,
        readSelectedProductOptions,
        ensureAvailableProductQuantity,
        validateRequestedServiceTags,
        getProductUnitPriceCents,
        getConfigurationAvailableQuantity,
        productCategoryList,
        snapshotPackBundleItems,
        getPromoCodeOutcome,
        getPromoCodeLabel,
        getProductById,
        createOrder,
        markOrderPaid,
        updateOrderRecord,
    });
    const orderUpdateService = createOrderUpdateService({
        db,
        normalizeText,
        normalizeOrderDateTimeField,
        getOrderAdminData,
        canEditOrderReceivedAmount,
        readReceivedPaymentInput,
        getOrderPaymentData,
        markOrderPaid,
        updateOrderRecord,
    });

    function sendOrderDocumentPdf(req, res, type) {
        const order = getOrderById(db, Number.parseInt(req.params.id, 10));
        if (!order) {
            return res.status(404).render("not-found", { title: "Commande introuvable" });
        }

        const pdf = buildOrderDocumentPdf({
            type,
            order,
            settings: res.locals.settings || getSettings(db),
            contact: getOrderContactSnapshot(order),
            admin: getOrderAdminData(order),
            getOrderStatusLabel,
            getOrderProviderLabel,
            baseUrl: baseUrl(req),
            config: getOrderDocumentConfig(req),
        });
        const filename = buildOrderDocumentFilename(order, type);

        applyOrderDocumentResponseHeaders(res, pdf, filename);

        return res.send(pdf);
    }

    app.get("/admin/orders", requireAdmin, (req, res) => {
        render(res, "admin/orders", buildOrderListViewModel({
            db,
            queryParams: req.query,
            normalizeText,
            listOrders,
            countOrders,
        }));
    });

    app.get("/admin/orders/new", requireAdmin, (req, res) => {
        render(res, "admin/order-form", {
            title: "Nouvelle commande",
            products: listAdminProducts(db),
            promoCodes: listPromoCodes(db),
            orderStatusOptions: ORDER_STATUS_OPTIONS,
        });
    });

    app.post("/admin/orders/new", requireAdmin, (req, res) => {
        try {
            const finalizedOrder = manualOrderService.createManualOrder(req.body, req.currentAdmin);

            setFlash(req, "success", `Commande ${finalizedOrder.order_number} créée.`);
            return saveSessionAndRedirect(req, res, `/admin/orders/${finalizedOrder.id}`);
        } catch (error) {
            setFlash(req, "error", error.message);
            return saveSessionAndRedirect(req, res, "/admin/orders/new");
        }
    });

    app.get("/admin/orders/:id/invoice.pdf", requireAdmin, (req, res) => {
        return sendOrderDocumentPdf(req, res, "invoice");
    });

    app.get("/admin/orders/:id/delivery-slip.pdf", requireAdmin, (req, res) => {
        return sendOrderDocumentPdf(req, res, "delivery-slip");
    });

    app.get("/admin/orders/:id", requireAdmin, (req, res) => {
        const order = getOrderById(db, Number.parseInt(req.params.id, 10));
        if (!order) {
            return res.status(404).render("not-found", { title: "Commande introuvable" });
        }

        const contact = getOrderContactSnapshot(order);
        const admin = getOrderAdminData(order);
        const emailDraft = buildOrderEmailDraft(order);
        const settings = res.locals.settings;

        render(res, "admin/order-detail", {
            title: `Commande ${order.order_number}`,
            order,
            contact,
            admin,
            orderStatusOptions: ORDER_STATUS_OPTIONS,
            contactMailto: buildOrderMailto(order),
            mailConfigured: isMailConfigured(settings),
            defaultEmailSubject: emailDraft.subject,
            defaultEmailMessage: emailDraft.message,
        });
    });

    app.post("/admin/orders/:id/update", requireAdmin, (req, res) => {
        const order = getOrderById(db, Number.parseInt(req.params.id, 10));
        if (!order) {
            return res.status(404).render("not-found", { title: "Commande introuvable" });
        }

        try {
            const nextOrder = orderUpdateService.updateOrderFromInput(order, req.body);

            setFlash(req, "success", "Commande mise à jour.");
            return saveSessionAndRedirect(req, res, `/admin/orders/${nextOrder.id}`);
        } catch (error) {
            setFlash(req, "error", error.message);
            return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
        }
    });

    app.post("/admin/orders/:id/send-email", requireAdmin, async (req, res) => {
        const order = getOrderById(db, Number.parseInt(req.params.id, 10));
        if (!order) {
            return res.status(404).render("not-found", { title: "Commande introuvable" });
        }

        const settings = getSettings(db);
        const emailRequest = readOrderEmailRequest({
            values: req.body,
            order,
            settings,
            normalizeText,
            normalizeSingleLineText,
            getMailConfigError,
        });
        if (emailRequest.error) {
            setFlash(req, "error", emailRequest.error);
            return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
        }

        try {
            await sendStoreEmail(settings, {
                to: order.customer_email,
                subject: emailRequest.subject,
                text: emailRequest.message,
            });
            setFlash(req, "success", "E-mail envoyé au client.");
        } catch (error) {
            setFlash(req, "error", `Échec de l'envoi : ${error.message}`);
        }

        return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
    });

    app.post("/admin/orders/:id/delete", requireAdmin, (req, res) => {
        const order = getOrderById(db, Number.parseInt(req.params.id, 10));
        if (!order) {
            setFlash(req, "error", "Commande introuvable.");
            return saveSessionAndRedirect(req, res, "/admin/orders");
        }

        deleteOrder(db, order.id);
        setFlash(req, "success", `La commande ${order.order_number} a été supprimée.`);
        return saveSessionAndRedirect(req, res, "/admin/orders");
    });
}

module.exports = { registerAdminOrderRoutes };
