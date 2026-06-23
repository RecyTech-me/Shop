const { buildOrderDocumentPdf, buildOrderDocumentFilename } = require("../../lib/order-documents");
const {
    ORDER_STATUS_OPTIONS,
    getOrderStatusLabel,
    getOrderProviderLabel,
} = require("../../lib/shop-formatters");

function registerAdminOrderRoutes(deps) {
    const {
        app,
        db,
        requireAdmin,
        render,
        setFlash,
        saveSessionAndRedirect,
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
        getOrderContactSnapshot,
        getOrderAdminData,
        buildOrderMailto,
        buildOrderEmailDraft,
        isMailConfigured,
        getMailConfigError,
        sendStoreEmail,
        canEditOrderReceivedAmount,
        readReceivedPaymentInput,
        getOrderPaymentData,
        baseUrl,
        getOrderDocumentConfig,
        getSettings,
        listAdminProducts,
        getProductById,
        listPromoCodes,
        createOrder,
        getOrderById,
        updateOrderRecord,
        markOrderPaid,
        listOrders,
        deleteOrder,
    } = deps;

    function readManualOrderInput(values) {
        const productId = Number.parseInt(values.product_id, 10);
        const quantity = Math.max(1, Number.parseInt(values.quantity || "1", 10) || 1);
        const customerName = normalizeSingleLineText(values.customer_name);
        const customerEmail = normalizeSingleLineText(values.customer_email);
        const customerPhone = normalizeSingleLineText(values.customer_phone);
        const paymentLabel = normalizeSingleLineText(values.payment_label) || "Vente hors site";
        const status = normalizeText(values.status) || "paid";
        const internalNote = normalizeText(values.internal_note);
        const priceOverrideRaw = String(values.unit_price_chf || "").trim();
        const unitPriceOverrideCents = priceOverrideRaw ? parseMoneyToCents(priceOverrideRaw, Number.NaN) : null;
        const discountRaw = String(values.discount_chf || "").trim();
        const discountCents = discountRaw ? parseMoneyToCents(discountRaw, Number.NaN) : 0;
        const receivedAmountCents = parseOptionalMoneyToCents(values.actual_received_chf, "Montant réellement reçu");
        const createdAt = normalizeOrderDateTimeField(values.order_created_at, new Date().toISOString());
        const promoCode = normalizePromoCode(values.promo_code);
        const serviceTags = [...new Set(
            (Array.isArray(values.service_tags) ? values.service_tags : [values.service_tags])
                .map((tag) => normalizeSingleLineText(tag))
                .filter(Boolean)
        )];

        if (!customerName) {
            throw new Error("Le nom du client est obligatoire.");
        }

        if (!Number.isInteger(productId) || productId <= 0) {
            throw new Error("Produit invalide.");
        }

        if (!ORDER_STATUS_OPTIONS.some((option) => option.value === status)) {
            throw new Error("Statut de commande invalide.");
        }

        if (unitPriceOverrideCents !== null && (!Number.isFinite(unitPriceOverrideCents) || unitPriceOverrideCents < 0)) {
            throw new Error("Prix unitaire invalide.");
        }

        if (!Number.isFinite(discountCents) || discountCents < 0) {
            throw new Error("Remise invalide.");
        }

        return {
            productId,
            quantity,
            customerName,
            customerEmail,
            customerPhone,
            paymentLabel,
            status,
            internalNote,
            unitPriceOverrideCents,
            createdAt,
            discountCents,
            receivedAmountCents,
            promoCode,
            serviceTags,
        };
    }

    function buildManualOrderDiscount(input, subtotalCents) {
        const manualDiscountCents = input.discountCents || 0;
        const promoOutcome = input.promoCode ? getPromoCodeOutcome(input.promoCode, subtotalCents) : null;

        if (manualDiscountCents > subtotalCents) {
            throw new Error("La remise ne peut pas dépasser le total des articles.");
        }

        if (promoOutcome?.error && manualDiscountCents <= 0) {
            throw new Error(promoOutcome.error);
        }

        const discountCents = manualDiscountCents > 0
            ? manualDiscountCents
            : promoOutcome?.discountCents || 0;
        const promoCode = promoOutcome?.code || input.promoCode || "";
        const validPromoCode = promoOutcome && !promoOutcome.error ? promoOutcome.promoCode : null;
        const label = promoCode
            ? getPromoCodeLabel({ code: promoCode })
            : "Remise manuelle";

        return {
            discountCents,
            discountLine: discountCents > 0
                ? {
                    type: "discount",
                    code: promoCode,
                    label,
                    amount_cents: -discountCents,
                }
                : null,
            promo: promoCode
                ? {
                    id: validPromoCode?.id || null,
                    code: promoCode,
                    description: validPromoCode?.description || "",
                    discount_type: validPromoCode?.discount_type || (manualDiscountCents > 0 ? "manual" : ""),
                    discount_value: validPromoCode?.discount_value || discountCents,
                    discount_cents: discountCents,
                    label,
                    manual_override: manualDiscountCents > 0,
                }
                : null,
        };
    }

    function buildManualOrderItem(product, input) {
        const selectedOptions = Array.isArray(input.selectedOptions) ? input.selectedOptions : [];
        const unitPriceCents = input.unitPriceOverrideCents ?? getProductUnitPriceCents(product, selectedOptions);
        const availableQuantity = getConfigurationAvailableQuantity(product, selectedOptions);

        return {
            product_id: product.id,
            item_key: `manual:${product.id}:${JSON.stringify(selectedOptions)}:${Date.now()}`,
            slug: product.slug,
            name: product.name,
            product_kind: product.product_kind,
            is_pack: Boolean(product.is_pack),
            category: product.category,
            categories: productCategoryList(product),
            short_description: product.short_description,
            image_url: product.image_url,
            selected_options: selectedOptions,
            service_tags: Array.isArray(input.serviceTags) ? input.serviceTags : [],
            bundle_items: snapshotPackBundleItems(product),
            quantity: input.quantity,
            unit_price_cents: unitPriceCents,
            line_total_cents: unitPriceCents * input.quantity,
            inventory: availableQuantity,
        };
    }

    function finalizeManualOrderStatus(order, targetStatus, metadata) {
        const stockReducingStatuses = new Set(["paid", "processing", "ready_for_pickup", "shipped", "completed"]);

        if (!stockReducingStatuses.has(targetStatus)) {
            return updateOrderRecord(db, order.id, {
                status: targetStatus,
                metadata,
            });
        }

        const paidOrder = markOrderPaid(db, order.id, metadata);
        if (targetStatus === "paid") {
            return paidOrder;
        }

        return updateOrderRecord(db, paidOrder.id, {
            status: targetStatus,
        });
    }

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

        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${filename}"`,
            "Cache-Control": "private, no-store",
            "Content-Length": String(pdf.length),
        });

        return res.send(pdf);
    }

    app.get("/admin/orders", requireAdmin, (req, res) => {
        const status = normalizeText(req.query.status);
        const query = normalizeText(req.query.q);

        render(res, "admin/orders", {
            title: "Commandes",
            orders: listOrders(db, {
                status: status || null,
                query: query || null,
            }),
            filters: {
                status,
                query,
            },
            orderStatusOptions: ORDER_STATUS_OPTIONS,
        });
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
            const input = readManualOrderInput(req.body);
            const product = getProductById(db, input.productId);

            if (!product) {
                throw new Error("Produit introuvable.");
            }

            if (product.inventory <= 0) {
                throw new Error("Ce produit est en rupture de stock.");
            }

            const selectedOptions = readSelectedProductOptions(product, req.body);
            ensureAvailableProductQuantity(product, selectedOptions, input.quantity);
            const serviceTags = validateRequestedServiceTags(product, selectedOptions, input.serviceTags, input.quantity);
            const item = buildManualOrderItem(product, { ...input, selectedOptions, serviceTags });
            const discount = buildManualOrderDiscount(input, item.line_total_cents);
            const amountCents = Math.max(0, item.line_total_cents - discount.discountCents);
            const metadata = {
                checkout: {
                    customer_first_name: input.customerName,
                    shipping_phone: input.customerPhone,
                },
                delivery: {
                    method: "manual",
                    label: "Vente hors site",
                    amount_cents: 0,
                },
                additions: discount.discountLine ? [discount.discountLine] : [],
                promo: discount.promo,
                manual: {
                    created_by_admin_id: req.currentAdmin?.id || null,
                    created_by_admin_username: req.currentAdmin?.username || "",
                    payment_label: input.paymentLabel,
                    discount_cents: discount.discountCents,
                },
                payment: input.receivedAmountCents === null
                    ? {}
                    : {
                        received_amount_cents: input.receivedAmountCents,
                        received_amount_recorded_at: new Date().toISOString(),
                    },
                admin: {
                    internal_note: input.internalNote,
                    customer_note: "",
                    fulfillment_note: "",
                    carrier: "",
                    tracking_number: "",
                    pickup_details: "",
                },
            };

            const order = createOrder(db, {
                provider: "manual",
                provider_reference: null,
                customer_name: input.customerName,
                customer_email: input.customerEmail,
                amount_cents: amountCents,
                currency: product.currency || "CHF",
                items: [item],
                status: "pending",
                metadata,
                created_at: input.createdAt,
            });
            const finalizedOrder = finalizeManualOrderStatus(order, input.status, metadata);

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

        const status = normalizeText(req.body.status);
        if (!ORDER_STATUS_OPTIONS.some((option) => option.value === status)) {
            setFlash(req, "error", "Statut de commande invalide.");
            return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
        }

        let createdAt = order.created_at;
        try {
            createdAt = normalizeOrderDateTimeField(req.body.order_created_at, order.created_at);
        } catch (error) {
            setFlash(req, "error", error.message);
            return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
        }

        const currentAdminData = getOrderAdminData(order);
        const nextAdminData = {
            ...currentAdminData,
            internal_note: normalizeText(req.body.internal_note),
            customer_note: normalizeText(req.body.customer_note),
            fulfillment_note: normalizeText(req.body.fulfillment_note),
            carrier: normalizeText(req.body.carrier),
            tracking_number: normalizeText(req.body.tracking_number),
            pickup_details: normalizeText(req.body.pickup_details),
        };

        let nextOrder = null;
        try {
            const nextPaymentData = canEditOrderReceivedAmount(order)
                ? readReceivedPaymentInput(req.body, order)
                : getOrderPaymentData(order);
            const metadataUpdate = {
                admin: nextAdminData,
                payment: nextPaymentData,
            };

            if (status === "paid" && order.status !== "paid") {
                const paidOrder = markOrderPaid(db, order.id, {
                    ...metadataUpdate,
                });
                nextOrder = updateOrderRecord(db, paidOrder.id, {
                    created_at: createdAt,
                    metadata: metadataUpdate,
                });
            } else {
                nextOrder = updateOrderRecord(db, order.id, {
                    status,
                    created_at: createdAt,
                    metadata: metadataUpdate,
                });
            }
        } catch (error) {
            setFlash(req, "error", error.message);
            return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
        }

        setFlash(req, "success", "Commande mise à jour.");
        return saveSessionAndRedirect(req, res, `/admin/orders/${nextOrder.id}`);
    });

    app.post("/admin/orders/:id/send-email", requireAdmin, async (req, res) => {
        const order = getOrderById(db, Number.parseInt(req.params.id, 10));
        if (!order) {
            return res.status(404).render("not-found", { title: "Commande introuvable" });
        }

        if (!order.customer_email) {
            setFlash(req, "error", "Aucun e-mail client n'est renseigné pour cette commande.");
            return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
        }

        const subject = normalizeSingleLineText(req.body.subject);
        const message = normalizeText(req.body.message);
        if (!subject || !message) {
            setFlash(req, "error", "Le sujet et le message sont obligatoires.");
            return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
        }

        const settings = getSettings(db);
        const configError = getMailConfigError(settings);
        if (configError) {
            setFlash(req, "error", `Envoi impossible : ${configError}`);
            return saveSessionAndRedirect(req, res, `/admin/orders/${order.id}`);
        }

        try {
            await sendStoreEmail(settings, {
                to: order.customer_email,
                subject,
                text: message,
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
