function registerAdminCatalogRoutes(deps) {
    const {
        app,
        db,
        requireAdmin,
        render,
        getViewHelpers,
        setFlash,
        saveSessionAndRedirect,
        normalizeText,
        settingsUploadUrl,
        withProductUploads,
        withSettingsUpload,
        productInputWithUploads,
        buildProductFormState,
        getSettings,
        saveSettings,
        createProduct,
        updateProduct,
        deleteProduct,
        listPacksContainingProduct,
        listProductCategories,
        listAdminCategories,
        deleteProductCategory,
        getProductById,
    } = deps;

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

module.exports = { registerAdminCatalogRoutes };
