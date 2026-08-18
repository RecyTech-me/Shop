const { parseInteger } = require("../../lib/input-utils");
const { readSalesAnalyticsFilters } = require("../../lib/sales-analytics");

function registerAdminDashboardRoutes(deps) {
    const {
        app,
        db,
        http,
        products,
        reviews,
        dashboard,
        orders,
    } = deps;
    const { requireAdmin, render, setFlash, saveSessionAndRedirect } = http;
    const { listAdminProductRows } = products;
    const { listPendingSiteReviews, approveSiteReview, deleteSiteReview } = reviews;
    const { getDashboardStats, getSalesAnalytics } = dashboard;
    const { listRecentOrders } = orders;

    app.get("/admin", requireAdmin, (req, res) => {
        render(res, "admin/dashboard", {
            title: "Administration",
            stats: getDashboardStats(db),
            products: listAdminProductRows(db),
            recentOrders: listRecentOrders(db),
            pendingReviews: listPendingSiteReviews(db),
        });
    });

    app.get("/admin/analytics", requireAdmin, (req, res) => {
        const filters = readSalesAnalyticsFilters(req.query);
        render(res, "admin/analytics", {
            title: "Statistiques",
            filters,
            analytics: getSalesAnalytics(db, filters),
        });
    });

    app.post("/admin/reviews/:id/approve", requireAdmin, (req, res) => {
        const reviewId = parseInteger(req.params.id, Number.NaN);
        const review = approveSiteReview(db, reviewId);

        if (!review) {
            setFlash(req, "error", "Avis introuvable.");
        } else {
            setFlash(req, "success", "Avis publié.");
        }

        return saveSessionAndRedirect(req, res, "/admin#reviews");
    });

    app.post("/admin/reviews/:id/delete", requireAdmin, (req, res) => {
        const reviewId = parseInteger(req.params.id, Number.NaN);
        const deleted = deleteSiteReview(db, reviewId);

        setFlash(req, deleted ? "success" : "error", deleted ? "Avis supprimé." : "Avis introuvable.");
        return saveSessionAndRedirect(req, res, "/admin#reviews");
    });
}

module.exports = { registerAdminDashboardRoutes };
