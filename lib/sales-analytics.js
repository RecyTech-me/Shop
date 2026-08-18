const { normalizeDateField, parseShopLocalDateTime } = require("./input-utils");
const { PAID_ORDER_STATUSES } = require("./order-statuses");

const DEFAULT_PERIOD = "30d";
const MAX_ANALYTICS_DAYS = 366;
const PERIOD_DAYS = Object.freeze({
    "7d": 7,
    "30d": 30,
    "90d": 90,
    "365d": 365,
});
const ANALYTICS_PROVIDERS = Object.freeze([
    "all",
    "stripe",
    "swissbitcoinpay",
    "transfer",
    "cash",
    "manual",
]);
const paidOrderStatuses = new Set(PAID_ORDER_STATUSES);
const shopDateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});
const shortDateFormatter = new Intl.DateTimeFormat("fr-CH", {
    day: "numeric",
    month: "short",
});
const longDateFormatter = new Intl.DateTimeFormat("fr-CH", {
    day: "numeric",
    month: "long",
    year: "numeric",
});

function toShopDate(value) {
    const parts = Object.fromEntries(shopDateFormatter.formatToParts(value).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateFromString(value) {
    return new Date(`${value}T12:00:00.000Z`);
}

function shiftDate(value, days) {
    const date = dateFromString(value);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function dayCount(from, to) {
    return Math.floor((dateFromString(to) - dateFromString(from)) / 86_400_000) + 1;
}

function dateRangeToIso(from, to) {
    return {
        startIso: parseShopLocalDateTime(`${from}T00:00:00`).toISOString(),
        endExclusiveIso: parseShopLocalDateTime(`${shiftDate(to, 1)}T00:00:00`).toISOString(),
    };
}

function formatRangeLabel(from, to) {
    return `Du ${longDateFormatter.format(dateFromString(from))} au ${longDateFormatter.format(dateFromString(to))}`;
}

function defaultDateRange(now) {
    const to = toShopDate(now);
    return {
        from: shiftDate(to, -(PERIOD_DAYS[DEFAULT_PERIOD] - 1)),
        to,
    };
}

function readSalesAnalyticsFilters(query = {}, now = new Date()) {
    const requestedPeriod = String(query.period || DEFAULT_PERIOD).trim();
    const requestedProvider = String(query.provider || "all").trim();
    const provider = ANALYTICS_PROVIDERS.includes(requestedProvider) ? requestedProvider : "all";
    let period = Object.hasOwn(PERIOD_DAYS, requestedPeriod) || requestedPeriod === "custom"
        ? requestedPeriod
        : DEFAULT_PERIOD;
    let from;
    let to;
    let error = "";

    if (period === "custom") {
        from = normalizeDateField(query.from);
        to = normalizeDateField(query.to);
        if (!from || !to) {
            error = "Choisissez une date de début et une date de fin valides.";
        } else if (from > to) {
            error = "La date de début doit précéder la date de fin.";
        } else if (dayCount(from, to) > MAX_ANALYTICS_DAYS) {
            error = `La période personnalisée est limitée à ${MAX_ANALYTICS_DAYS} jours.`;
        }
    } else {
        to = toShopDate(now);
        from = shiftDate(to, -(PERIOD_DAYS[period] - 1));
    }

    if (error) {
        period = DEFAULT_PERIOD;
        ({ from, to } = defaultDateRange(now));
    }

    const days = dayCount(from, to);
    const previousTo = shiftDate(from, -1);
    const previousFrom = shiftDate(previousTo, -(days - 1));

    return {
        period,
        provider,
        from,
        to,
        days,
        error,
        label: formatRangeLabel(from, to),
        ...dateRangeToIso(from, to),
        previousFrom,
        previousTo,
        previousLabel: formatRangeLabel(previousFrom, previousTo),
        previousRange: dateRangeToIso(previousFrom, previousTo),
    };
}

function safeJson(value, fallback) {
    try {
        const parsed = JSON.parse(value || "");
        return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function readAnalyticsOrders(db, range, provider) {
    const values = [range.startIso, range.endExclusiveIso];
    const providerClause = provider === "all" ? "" : "AND provider = ?";
    if (provider !== "all") {
        values.push(provider);
    }

    return db.prepare(`
        SELECT id, provider, status, amount_cents, items_json, metadata_json, created_at
        FROM orders
        WHERE created_at >= ?
          AND created_at < ?
          ${providerClause}
        ORDER BY created_at ASC
    `).all(...values).map((order) => {
        const items = safeJson(order.items_json, []);
        const metadata = safeJson(order.metadata_json, {});
        return {
            ...order,
            items: Array.isArray(items) ? items : [],
            metadata: metadata && !Array.isArray(metadata) ? metadata : {},
        };
    });
}

function receivedAmountCents(order) {
    const received = Number(order.metadata?.payment?.received_amount_cents);
    return Number.isSafeInteger(received) && received >= 0 ? received : Math.max(order.amount_cents || 0, 0);
}

function discountCents(order) {
    const candidates = [
        order.metadata?.promo?.discount_cents,
        order.metadata?.manual?.discount_cents,
    ];
    const value = candidates.map(Number).find((candidate) => Number.isSafeInteger(candidate) && candidate > 0);
    return value || 0;
}

function percentageChange(current, previous) {
    if (!previous) {
        return current ? null : 0;
    }
    return Math.round(((current - previous) / previous) * 1000) / 10;
}

function summarizeOrders(orders) {
    const paidOrders = orders.filter((order) => paidOrderStatuses.has(order.status));
    const refundedOrders = orders.filter((order) => order.status === "refunded");
    const netRevenueCents = paidOrders.reduce((sum, order) => sum + receivedAmountCents(order), 0);
    const refundedCents = refundedOrders.reduce((sum, order) => sum + receivedAmountCents(order), 0);
    const itemsSold = paidOrders.reduce((sum, order) => sum + order.items.reduce((itemSum, item) => (
        itemSum + Math.max(Number.parseInt(item.quantity, 10) || 0, 0)
    ), 0), 0);
    const discountsCents = paidOrders.reduce((sum, order) => sum + discountCents(order), 0);

    return {
        totalOrders: orders.length,
        paidOrders: paidOrders.length,
        pendingOrders: orders.filter((order) => ["pending", "awaiting_transfer"].includes(order.status)).length,
        refundedOrders: refundedOrders.length,
        cancelledOrders: orders.filter((order) => ["cancelled", "failed"].includes(order.status)).length,
        netRevenueCents,
        refundedCents,
        averageOrderCents: paidOrders.length ? Math.round(netRevenueCents / paidOrders.length) : 0,
        itemsSold,
        discountsCents,
        promoOrders: paidOrders.filter((order) => order.metadata?.promo?.code).length,
    };
}

function addToDistribution(map, key, values) {
    const current = map.get(key) || { key, orders: 0, revenueCents: 0 };
    current.orders += values.orders || 0;
    current.revenueCents += values.revenueCents || 0;
    map.set(key, current);
}

function buildDistributions(orders) {
    const statuses = new Map();
    const providers = new Map();
    const deliveryMethods = new Map();
    const products = new Map();

    for (const order of orders) {
        addToDistribution(statuses, order.status, { orders: 1 });
        if (!paidOrderStatuses.has(order.status)) {
            continue;
        }

        const revenueCents = receivedAmountCents(order);
        addToDistribution(providers, order.provider, { orders: 1, revenueCents });
        const deliveryKey = String(order.metadata?.delivery?.method || "unknown");
        const deliveryLabel = String(order.metadata?.delivery?.label || "Non renseigné");
        const delivery = deliveryMethods.get(deliveryKey) || {
            key: deliveryKey,
            label: deliveryLabel,
            orders: 0,
        };
        delivery.orders += 1;
        deliveryMethods.set(deliveryKey, delivery);

        for (const item of order.items) {
            const key = String(item.product_id || item.name || "unknown");
            const quantity = Math.max(Number.parseInt(item.quantity, 10) || 0, 0);
            const itemRevenueCents = Number.isSafeInteger(item.line_total_cents)
                ? item.line_total_cents
                : (Number.parseInt(item.unit_price_cents, 10) || 0) * quantity;
            const product = products.get(key) || {
                key,
                name: String(item.name || "Produit inconnu"),
                quantity: 0,
                revenueCents: 0,
            };
            product.quantity += quantity;
            product.revenueCents += Math.max(itemRevenueCents, 0);
            products.set(key, product);
        }
    }

    return {
        statuses: [...statuses.values()].sort((a, b) => b.orders - a.orders),
        providers: [...providers.values()].sort((a, b) => b.revenueCents - a.revenueCents),
        deliveryMethods: [...deliveryMethods.values()].sort((a, b) => b.orders - a.orders),
        topProducts: [...products.values()]
            .sort((a, b) => b.revenueCents - a.revenueCents || b.quantity - a.quantity)
            .slice(0, 8),
    };
}

function buildTrend(orders, filters) {
    const paidOrders = orders.filter((order) => paidOrderStatuses.has(order.status));
    let bucketType = "day";
    if (filters.days > 120) {
        bucketType = "month";
    } else if (filters.days > 31) {
        bucketType = "week";
    }

    const buckets = [];
    if (bucketType === "month") {
        let cursor = `${filters.from.slice(0, 7)}-01`;
        const lastMonth = filters.to.slice(0, 7);
        while (cursor.slice(0, 7) <= lastMonth) {
            buckets.push({
                key: cursor.slice(0, 7),
                label: new Intl.DateTimeFormat("fr-CH", { month: "short", year: "2-digit" }).format(dateFromString(cursor)),
                orders: 0,
                revenueCents: 0,
            });
            const next = dateFromString(cursor);
            next.setUTCMonth(next.getUTCMonth() + 1);
            cursor = next.toISOString().slice(0, 10);
        }
    } else {
        const increment = bucketType === "week" ? 7 : 1;
        for (let cursor = filters.from; cursor <= filters.to; cursor = shiftDate(cursor, increment)) {
            const bucketEnd = bucketType === "week" ? [shiftDate(cursor, 6), filters.to].sort()[0] : cursor;
            buckets.push({
                key: cursor,
                end: bucketEnd,
                label: bucketType === "week"
                    ? `${shortDateFormatter.format(dateFromString(cursor))}–${shortDateFormatter.format(dateFromString(bucketEnd))}`
                    : shortDateFormatter.format(dateFromString(cursor)),
                orders: 0,
                revenueCents: 0,
            });
        }
    }

    for (const order of paidOrders) {
        const orderDate = toShopDate(new Date(order.created_at));
        const bucket = bucketType === "month"
            ? buckets.find((candidate) => candidate.key === orderDate.slice(0, 7))
            : buckets.find((candidate) => orderDate >= candidate.key && orderDate <= (candidate.end || candidate.key));
        if (bucket) {
            bucket.orders += 1;
            bucket.revenueCents += receivedAmountCents(order);
        }
    }

    const labelInterval = Math.max(Math.ceil(buckets.length / 7), 1);
    return {
        bucketType,
        maxRevenueCents: Math.max(...buckets.map((bucket) => bucket.revenueCents), 1),
        buckets: buckets.map((bucket, index) => ({
            ...bucket,
            showLabel: index % labelInterval === 0 || index === buckets.length - 1,
        })),
    };
}

function getSalesAnalytics(db, filters) {
    const currentOrders = readAnalyticsOrders(db, filters, filters.provider);
    const previousOrders = readAnalyticsOrders(db, filters.previousRange, filters.provider);
    const summary = summarizeOrders(currentOrders);
    const previousSummary = summarizeOrders(previousOrders);

    return {
        summary,
        previousSummary,
        comparisons: {
            revenue: percentageChange(summary.netRevenueCents, previousSummary.netRevenueCents),
            orders: percentageChange(summary.paidOrders, previousSummary.paidOrders),
            averageOrder: percentageChange(summary.averageOrderCents, previousSummary.averageOrderCents),
            items: percentageChange(summary.itemsSold, previousSummary.itemsSold),
        },
        trend: buildTrend(currentOrders, filters),
        ...buildDistributions(currentOrders),
    };
}

module.exports = {
    getSalesAnalytics,
    readSalesAnalyticsFilters,
};
