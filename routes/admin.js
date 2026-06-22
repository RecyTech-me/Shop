const { verifyPassword } = require("../lib/auth");
const { buildOrderDocumentPdf, buildOrderDocumentFilename } = require("../lib/order-documents");
const {
    ORDER_STATUS_OPTIONS,
    ADMIN_ROLE_OPTIONS,
    getOrderStatusLabel,
    getOrderProviderLabel,
} = require("../lib/shop-formatters");

function registerAdminRoutes(deps) {
    const {
        app,
        db,
        requireAdmin,
        requireSuperadmin,
        render,
        getViewHelpers,
        setFlash,
        saveSessionAndRedirect,
        normalizeText,
        normalizeSingleLineText,
        parseMoneyToCents,
        parseOptionalMoneyToCents,
        normalizeOrderDateTimeField,
        normalizePromoCode,
        readAdminUserInput,
        readAdminAccountInput,
        readPromoCodeInput,
        getLoginRateLimitState,
        registerLoginFailure,
        clearLoginFailures,
        getOrCreateCsrfToken,
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
        settingsUploadUrl,
        withProductUploads,
        withSettingsUpload,
        productInputWithUploads,
        buildProductFormState,
        baseUrl,
        getOrderDocumentConfig,
        getSettings,
        saveSettings,
        createProduct,
        updateProduct,
        deleteProduct,
        listPacksContainingProduct,
        listAdminProducts,
        listProductCategories,
        listAdminCategories,
        deleteProductCategory,
        getProductById,
        getAdminByUsername,
        getAdminById,
        listAdmins,
        countAdminsByRole,
        createAdminUser,
        updateAdminUser,
        deleteAdminUser,
        listPendingSiteReviews,
        approveSiteReview,
        deleteSiteReview,
        listPromoCodes,
        getPromoCodeById,
        createPromoCodeRecord,
        updatePromoCodeRecord,
        deletePromoCodeRecord,
        getDashboardStats,
        createOrder,
        getOrderById,
        updateOrderRecord,
        markOrderPaid,
        listRecentOrders,
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

    app.get("/admin/login", (req, res) => {
        if (req.session.adminId) {
            return res.redirect("/");
        }

        render(res, "admin/login", {
            title: "Connexion",
        });
    });

    app.post("/admin/login", (req, res) => {
        const rateLimitState = getLoginRateLimitState(req);
        if (rateLimitState.blockedUntil > Date.now()) {
            setFlash(req, "error", "Trop de tentatives de connexion. Réessayez plus tard.");
            return saveSessionAndRedirect(req, res, "/admin/login");
        }

        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");
        const admin = getAdminByUsername(db, username);

        if (!admin || !verifyPassword(password, admin.password_hash)) {
            registerLoginFailure(req);
            setFlash(req, "error", "Identifiants invalides.");
            return saveSessionAndRedirect(req, res, "/admin/login");
        }

        clearLoginFailures(req);
        req.session.regenerate((error) => {
            if (error) {
                setFlash(req, "error", "Impossible d'ouvrir une session sécurisée.");
                return saveSessionAndRedirect(req, res, "/admin/login");
            }

            req.session.adminId = admin.id;
            getOrCreateCsrfToken(req);
            setFlash(req, "success", "Connexion réussie.");
            return saveSessionAndRedirect(req, res, "/");
        });
    });

    app.post("/admin/logout", requireAdmin, (req, res) => {
        req.session.destroy(() => {
            res.clearCookie("connect.sid");
            res.redirect("/admin/login");
        });
    });

    app.get("/admin", requireAdmin, (req, res) => {
        render(res, "admin/dashboard", {
            title: "Administration",
            stats: getDashboardStats(db),
            products: listAdminProducts(db),
            recentOrders: listRecentOrders(db),
            pendingReviews: listPendingSiteReviews(db),
        });
    });

    app.post("/admin/reviews/:id/approve", requireAdmin, (req, res) => {
        const reviewId = Number.parseInt(req.params.id, 10);
        const review = approveSiteReview(db, reviewId);

        if (!review) {
            setFlash(req, "error", "Avis introuvable.");
        } else {
            setFlash(req, "success", "Avis publié.");
        }

        return saveSessionAndRedirect(req, res, "/admin#reviews");
    });

    app.post("/admin/reviews/:id/delete", requireAdmin, (req, res) => {
        const reviewId = Number.parseInt(req.params.id, 10);
        const deleted = deleteSiteReview(db, reviewId);

        setFlash(req, deleted ? "success" : "error", deleted ? "Avis supprimé." : "Avis introuvable.");
        return saveSessionAndRedirect(req, res, "/admin#reviews");
    });

    app.get("/admin/account", requireAdmin, (req, res) => {
        render(res, "admin/account", {
            title: "Mon compte",
        });
    });

    app.get("/admin/categories", requireAdmin, (req, res) => {
        render(res, "admin/categories", {
            title: "Catégories",
            categories: listAdminCategories(db),
        });
    });

    app.post("/admin/categories/delete", requireAdmin, (req, res) => {
        const categoryName = normalizeText(req.body.category);

        if (!categoryName) {
            setFlash(req, "error", "Catégorie invalide.");
            return saveSessionAndRedirect(req, res, "/admin/categories");
        }

        const result = deleteProductCategory(db, categoryName);
        if (!result.updatedProducts) {
            setFlash(req, "error", "Aucun produit n'utilise cette catégorie.");
            return saveSessionAndRedirect(req, res, "/admin/categories");
        }

        setFlash(req, "success", `La catégorie ${categoryName} a été retirée de ${result.updatedProducts} produit(s).`);
        return saveSessionAndRedirect(req, res, "/admin/categories");
    });

    app.post("/admin/account", requireAdmin, (req, res) => {
        const adminRecord = getAdminByUsername(db, req.currentAdmin.username);
        if (!adminRecord) {
            req.session.adminId = null;
            setFlash(req, "error", "Session administrateur invalide.");
            return saveSessionAndRedirect(req, res, "/admin/login");
        }

        try {
            const input = readAdminAccountInput(req.body, adminRecord);

            if ((input.usernameChanged || input.passwordChanged) && !verifyPassword(input.currentPassword, adminRecord.password_hash)) {
                throw new Error("Le mot de passe actuel est incorrect.");
            }

            updateAdminUser(db, adminRecord.id, {
                username: input.username,
                role: adminRecord.role,
                password: input.password,
            });

            setFlash(req, "success", "Votre compte a été mis à jour.");
            return saveSessionAndRedirect(req, res, "/admin/account");
        } catch (error) {
            const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
                ? "Ce nom d'utilisateur existe déjà."
                : error.message;
            setFlash(req, "error", message);
            return saveSessionAndRedirect(req, res, "/admin/account");
        }
    });

    app.get("/admin/admins", requireSuperadmin, (req, res) => {
        render(res, "admin/admins", {
            title: "Administrateurs",
            admins: listAdmins(db),
            superadminCount: countAdminsByRole(db, "superadmin"),
        });
    });

    app.get("/admin/admins/new", requireSuperadmin, (req, res) => {
        render(res, "admin/admin-form", {
            title: "Nouvel administrateur",
            formAction: "/admin/admins/new",
            adminUser: null,
            roleOptions: ADMIN_ROLE_OPTIONS,
            currentAdminId: req.currentAdmin.id,
        });
    });

    app.post("/admin/admins/new", requireSuperadmin, (req, res) => {
        try {
            const input = readAdminUserInput(req.body, { requirePassword: true });
            createAdminUser(db, input);
            setFlash(req, "success", "Administrateur créé.");
            return saveSessionAndRedirect(req, res, "/admin/admins");
        } catch (error) {
            const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
                ? "Ce nom d'utilisateur existe déjà."
                : error.message;
            setFlash(req, "error", message);
            return saveSessionAndRedirect(req, res, "/admin/admins/new");
        }
    });

    app.get("/admin/admins/:id/edit", requireSuperadmin, (req, res) => {
        const adminUser = getAdminById(db, Number.parseInt(req.params.id, 10));
        if (!adminUser) {
            return res.status(404).render("not-found", { title: "Administrateur introuvable" });
        }

        render(res, "admin/admin-form", {
            title: `Modifier ${adminUser.username}`,
            formAction: `/admin/admins/${adminUser.id}/edit`,
            adminUser,
            roleOptions: ADMIN_ROLE_OPTIONS,
            currentAdminId: req.currentAdmin.id,
        });
    });

    app.post("/admin/admins/:id/edit", requireSuperadmin, (req, res) => {
        const adminId = Number.parseInt(req.params.id, 10);
        const existingAdmin = getAdminById(db, adminId);
        if (!existingAdmin) {
            return res.status(404).render("not-found", { title: "Administrateur introuvable" });
        }

        try {
            const input = readAdminUserInput(req.body);
            if (existingAdmin.role === "superadmin" && input.role !== "superadmin" && countAdminsByRole(db, "superadmin") <= 1) {
                throw new Error("Le dernier superadmin ne peut pas être rétrogradé.");
            }

            updateAdminUser(db, adminId, input);
            setFlash(req, "success", "Administrateur mis à jour.");
            return saveSessionAndRedirect(req, res, "/admin/admins");
        } catch (error) {
            const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
                ? "Ce nom d'utilisateur existe déjà."
                : error.message;
            setFlash(req, "error", message);
            return saveSessionAndRedirect(req, res, `/admin/admins/${adminId}/edit`);
        }
    });

    app.post("/admin/admins/:id/delete", requireSuperadmin, (req, res) => {
        const adminId = Number.parseInt(req.params.id, 10);
        const adminUser = getAdminById(db, adminId);
        if (!adminUser) {
            return res.status(404).render("not-found", { title: "Administrateur introuvable" });
        }

        if (adminUser.id === req.currentAdmin.id) {
            setFlash(req, "error", "Vous ne pouvez pas supprimer votre propre compte.");
            return saveSessionAndRedirect(req, res, "/admin/admins");
        }

        if (adminUser.role === "superadmin" && countAdminsByRole(db, "superadmin") <= 1) {
            setFlash(req, "error", "Le dernier superadmin ne peut pas être supprimé.");
            return saveSessionAndRedirect(req, res, "/admin/admins");
        }

        deleteAdminUser(db, adminId);
        setFlash(req, "success", "Administrateur supprimé.");
        return saveSessionAndRedirect(req, res, "/admin/admins");
    });

    app.get("/admin/promo-codes", requireAdmin, (req, res) => {
        render(res, "admin/promo-codes", {
            title: "Codes promo",
            promoCodes: listPromoCodes(db),
        });
    });

    app.get("/admin/promo-codes/new", requireAdmin, (req, res) => {
        render(res, "admin/promo-code-form", {
            title: "Nouveau code promo",
            formAction: "/admin/promo-codes/new",
            promoCode: null,
        });
    });

    app.post("/admin/promo-codes/new", requireAdmin, (req, res) => {
        try {
            const input = readPromoCodeInput(req.body);
            createPromoCodeRecord(db, input);
            setFlash(req, "success", "Code promo créé.");
            return saveSessionAndRedirect(req, res, "/admin/promo-codes");
        } catch (error) {
            const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
                ? "Ce code promo existe déjà."
                : error.message;
            setFlash(req, "error", message);
            return saveSessionAndRedirect(req, res, "/admin/promo-codes/new");
        }
    });

    app.get("/admin/promo-codes/:id/edit", requireAdmin, (req, res) => {
        const promoCode = getPromoCodeById(db, Number.parseInt(req.params.id, 10));
        if (!promoCode) {
            return res.status(404).render("not-found", { title: "Code promo introuvable" });
        }

        render(res, "admin/promo-code-form", {
            title: `Modifier ${promoCode.code}`,
            formAction: `/admin/promo-codes/${promoCode.id}/edit`,
            promoCode,
        });
    });

    app.post("/admin/promo-codes/:id/edit", requireAdmin, (req, res) => {
        const promoCodeId = Number.parseInt(req.params.id, 10);

        try {
            const input = readPromoCodeInput(req.body);
            const promoCode = updatePromoCodeRecord(db, promoCodeId, input);

            if (!promoCode) {
                return res.status(404).render("not-found", { title: "Code promo introuvable" });
            }

            setFlash(req, "success", "Code promo mis à jour.");
            return saveSessionAndRedirect(req, res, "/admin/promo-codes");
        } catch (error) {
            const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
                ? "Ce code promo existe déjà."
                : error.message;
            setFlash(req, "error", message);
            return saveSessionAndRedirect(req, res, `/admin/promo-codes/${promoCodeId}/edit`);
        }
    });

    app.post("/admin/promo-codes/:id/delete", requireAdmin, (req, res) => {
        const promoCodeId = Number.parseInt(req.params.id, 10);
        const promoCode = getPromoCodeById(db, promoCodeId);

        if (!promoCode) {
            setFlash(req, "error", "Code promo introuvable.");
            return saveSessionAndRedirect(req, res, "/admin/promo-codes");
        }

        deletePromoCodeRecord(db, promoCodeId);
        setFlash(req, "success", `Le code promo ${promoCode.code} a été supprimé.`);
        return saveSessionAndRedirect(req, res, "/admin/promo-codes");
    });

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

    app.get("/admin/products/new", requireAdmin, (req, res) => {
        render(res, "admin/product-form", {
            title: "Nouveau produit",
            formAction: "/admin/products/new",
            product: null,
            categories: listProductCategories(db),
        });
    });

    app.post("/admin/products/new", requireAdmin, withProductUploads, (req, res) => {
        const productInput = productInputWithUploads(req);

        try {
            createProduct(db, productInput);
            setFlash(req, "success", "Produit créé.");
            return saveSessionAndRedirect(req, res, "/admin");
        } catch (error) {
            return res.status(400).render("admin/product-form", {
                ...getViewHelpers(),
                title: "Nouveau produit",
                formAction: "/admin/products/new",
                product: buildProductFormState(productInput),
                categories: listProductCategories(db),
                flash: {
                    type: "error",
                    message: `Création impossible : ${error.message}`,
                },
            });
        }
    });

    app.get("/admin/products/:id/edit", requireAdmin, (req, res) => {
        const product = getProductById(db, Number.parseInt(req.params.id, 10));
        if (!product) {
            return res.status(404).render("not-found", { title: "Produit introuvable" });
        }

        render(res, "admin/product-form", {
            title: `Modifier ${product.name}`,
            formAction: `/admin/products/${product.id}/edit`,
            product,
            categories: listProductCategories(db),
        });
    });

    app.post("/admin/products/:id/edit", requireAdmin, withProductUploads, (req, res) => {
        const productId = Number.parseInt(req.params.id, 10);
        const existingProduct = getProductById(db, productId);
        const productInput = productInputWithUploads(req);

        if (!existingProduct) {
            return res.status(404).render("not-found", { title: "Produit introuvable" });
        }

        try {
            updateProduct(db, productId, productInput);
            setFlash(req, "success", "Produit mis à jour.");
            return saveSessionAndRedirect(req, res, "/admin");
        } catch (error) {
            return res.status(400).render("admin/product-form", {
                ...getViewHelpers(),
                title: `Modifier ${existingProduct.name}`,
                formAction: `/admin/products/${productId}/edit`,
                product: buildProductFormState(productInput, existingProduct),
                categories: listProductCategories(db),
                flash: {
                    type: "error",
                    message: `Mise à jour impossible : ${error.message}`,
                },
            });
        }
    });

    app.post("/admin/products/:id/delete", requireAdmin, (req, res) => {
        const productId = Number.parseInt(req.params.id, 10);
        const referencingPacks = listPacksContainingProduct(db, productId);
        if (referencingPacks.length) {
            setFlash(req, "error", `Suppression impossible : ce produit est utilisé dans ${referencingPacks.length} pack(s).`);
            return saveSessionAndRedirect(req, res, `/admin/products/${productId}/edit`);
        }

        deleteProduct(db, productId);
        setFlash(req, "success", "Produit supprimé.");
        saveSessionAndRedirect(req, res, "/admin");
    });

    app.get("/admin/settings", requireAdmin, (req, res) => {
        render(res, "admin/settings", {
            title: "Paramètres de la boutique",
        });
    });

    app.post("/admin/settings", requireAdmin, withSettingsUpload, (req, res) => {
        const currentSettings = getSettings(db);
        const nextSmtpPassword = String(req.body.smtp_password || "").trim();
        saveSettings(db, {
            store_name: String(req.body.store_name || "").trim(),
            tagline: String(req.body.tagline || "").trim(),
            hero_title: String(req.body.hero_title || "").trim(),
            hero_text: String(req.body.hero_text || "").trim(),
            hero_image_url: settingsUploadUrl(req.file) || String(req.body.hero_image_url || "").trim(),
            hero_points: String(req.body.hero_points || "")
                .split(/\r?\n/)
                .map((point) => point.trim())
                .filter(Boolean)
                .join("\n"),
            support_email: String(req.body.support_email || "").trim(),
            support_address: String(req.body.support_address || "").trim(),
            bank_account_holder: String(req.body.bank_account_holder || "").trim(),
            bank_name: String(req.body.bank_name || "").trim(),
            bank_account_number: String(req.body.bank_account_number || "").trim(),
            bank_iban: String(req.body.bank_iban || "").trim(),
            bank_bic: String(req.body.bank_bic || "").trim(),
            smtp_host: String(req.body.smtp_host || "").trim(),
            smtp_port: String(req.body.smtp_port || "").trim() || "587",
            smtp_secure: req.body.smtp_secure ? "1" : "0",
            smtp_username: String(req.body.smtp_username || "").trim(),
            smtp_password: nextSmtpPassword || currentSettings.smtp_password || "",
            smtp_from_name: String(req.body.smtp_from_name || "").trim(),
            smtp_from_email: String(req.body.smtp_from_email || "").trim(),
            order_notification_email: String(req.body.order_notification_email || "").trim(),
        });

        setFlash(req, "success", "Paramètres enregistrés.");
        saveSessionAndRedirect(req, res, "/admin/settings");
    });
}

module.exports = { registerAdminRoutes };
