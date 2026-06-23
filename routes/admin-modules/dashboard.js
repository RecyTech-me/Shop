function registerAdminDashboardRoutes(deps) {
    const {
        app,
        db,
        requireAdmin,
        render,
        setFlash,
        saveSessionAndRedirect,
        listAdminProducts,
        listPendingSiteReviews,
        approveSiteReview,
        deleteSiteReview,
        getDashboardStats,
        listRecentOrders,
    } = deps;

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
}

module.exports = { registerAdminDashboardRoutes };
