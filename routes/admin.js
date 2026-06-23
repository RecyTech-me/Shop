const { registerAdminCatalogRoutes } = require("./admin-modules/catalog");
const { registerAdminDashboardRoutes } = require("./admin-modules/dashboard");
const { registerAdminOrderRoutes } = require("./admin-modules/orders");
const { registerAdminPromoCodeRoutes } = require("./admin-modules/promo-codes");
const { registerAdminSessionRoutes } = require("./admin-modules/session");

function registerAdminRoutes(deps) {
    registerAdminSessionRoutes(deps);
    registerAdminDashboardRoutes(deps);
    registerAdminPromoCodeRoutes(deps);
    registerAdminOrderRoutes(deps);
    registerAdminCatalogRoutes(deps);
}

module.exports = { registerAdminRoutes };
