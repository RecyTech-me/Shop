function registerAdminPromoCodeRoutes(deps) {
    const {
        app,
        db,
        requireAdmin,
        render,
        setFlash,
        saveSessionAndRedirect,
        readPromoCodeInput,
        listPromoCodes,
        getPromoCodeById,
        createPromoCodeRecord,
        updatePromoCodeRecord,
        deletePromoCodeRecord,
    } = deps;

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
}

module.exports = { registerAdminPromoCodeRoutes };
