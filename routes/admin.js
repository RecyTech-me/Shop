const { registerAdminCatalogRoutes } = require("./admin-modules/catalog");
const { registerAdminDashboardRoutes } = require("./admin-modules/dashboard");
const { registerAdminOrderRoutes } = require("./admin-modules/orders");
const { registerAdminPromoCodeRoutes } = require("./admin-modules/promo-codes");
const { registerAdminSessionRoutes } = require("./admin-modules/session");

function registerAdminRoutes(deps) {
    registerAdminSessionRoutes(deps.session);
    registerAdminDashboardRoutes(deps.dashboard);
    registerAdminPromoCodeRoutes(deps.promoCodes);
    registerAdminOrderRoutes(deps.orders);
    registerAdminCatalogRoutes(deps.catalog);
}

module.exports = { registerAdminRoutes };
