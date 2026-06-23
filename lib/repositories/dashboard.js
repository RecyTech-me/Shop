const { parseProduct } = require("../product-normalizers");
const { parseOrder } = require("./orders");
const { countPendingSiteReviews } = require("./site-reviews");

function getOrderReceivedAmountCents(order) {
    const receivedAmountCents = Number.parseInt(order?.metadata?.payment?.received_amount_cents, 10);
    return Number.isInteger(receivedAmountCents) && receivedAmountCents >= 0
        ? receivedAmountCents
        : null;
}

function getOrderRevenueAmountCents(order) {
    return getOrderReceivedAmountCents(order) ?? order.amount_cents ?? 0;
}

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
    const paidOrderRows = db.prepare("SELECT * FROM orders WHERE status = 'paid'").all().map(parseOrder);
    const paidOrders = paidOrderRows.length;
    const revenueCents = paidOrderRows.reduce((total, order) => total + getOrderRevenueAmountCents(order), 0);
    const activePromoCodes = db.prepare("SELECT COUNT(*) AS count FROM promo_codes WHERE active = 1").get().count;
    const pendingReviews = countPendingSiteReviews(db);
    const potentialRevenueCents = db.prepare(`
        SELECT *
        FROM products
        WHERE product_kind != 'pack'
    `).all()
        .map(parseProduct)
        .reduce((total, product) => total + getPotentialProductRevenueCents(product), 0);

    return {
        products,
        publishedProducts,
        paidOrders,
        revenueCents,
        activePromoCodes,
        pendingReviews,
        potentialRevenueCents,
    };
}

module.exports = { getDashboardStats };
