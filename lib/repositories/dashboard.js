const { parseProduct } = require("../product-normalizers");
const { PAID_ORDER_STATUSES } = require("../order-statuses");
const { countPendingSiteReviews } = require("./site-reviews");

function getPotentialProductRevenueCents(product) {
    const configurationRevenueCents = (product.valid_configurations || []).reduce((configurationTotal, configuration) => {
        const quantity = Number.isInteger(configuration.quantity) ? configuration.quantity : 0;
        const unitPriceCents = configuration.price_cents ?? product.price_cents;
        return configurationTotal + (quantity * unitPriceCents);
    }, 0);
    const reservedConfigurationStock = (product.valid_configurations || []).reduce((configurationStock, configuration) => (
        configurationStock + (Number.isInteger(configuration.quantity) ? configuration.quantity : 0)
    ), 0);
    const remainingGlobalStock = Math.max((product.inventory || 0) - reservedConfigurationStock, 0);

    return configurationRevenueCents + (remainingGlobalStock * product.price_cents);
}

function getDashboardStats(db) {
    const products = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;
    const publishedProducts = db.prepare("SELECT COUNT(*) AS count FROM products WHERE published = 1").get().count;
    const paidStatusPlaceholders = PAID_ORDER_STATUSES.map(() => "?").join(", ");
    const paidOrderStats = db.prepare(`
        SELECT
            COUNT(*) AS paidOrders,
            COALESCE(SUM(
                CASE
                    WHEN CAST(json_extract(metadata_json, '$.payment.received_amount_cents') AS INTEGER) >= 0
                        THEN CAST(json_extract(metadata_json, '$.payment.received_amount_cents') AS INTEGER)
                    ELSE amount_cents
                END
            ), 0) AS revenueCents
        FROM orders
        WHERE status IN (${paidStatusPlaceholders})
    `).get(...PAID_ORDER_STATUSES);
    const activePromoCodes = db.prepare("SELECT COUNT(*) AS count FROM promo_codes WHERE active = 1").get().count;
    const pendingReviews = countPendingSiteReviews(db);
    const potentialRevenueCents = db.prepare(`
        SELECT product_kind, category, categories_json, admin_notes, image_url, image_gallery_json,
               option_groups_json, info_rows_json, valid_configurations_json, bundle_items_json,
               price_cents, inventory
        FROM products
        WHERE product_kind != 'pack'
    `).all()
        .map(parseProduct)
        .reduce((total, product) => total + getPotentialProductRevenueCents(product), 0);

    return {
        products,
        publishedProducts,
        paidOrders: paidOrderStats.paidOrders,
        revenueCents: paidOrderStats.revenueCents,
        activePromoCodes,
        pendingReviews,
        potentialRevenueCents,
    };
}

module.exports = { getDashboardStats };
