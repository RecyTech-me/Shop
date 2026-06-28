const crypto = require("crypto");

const ORDER_COLUMNS = `
    id, order_number, provider, provider_reference, status,
    customer_name, customer_email, amount_cents, currency,
    items_json, metadata_json, created_at, updated_at
`;

function nowIso() {
    return new Date().toISOString();
}

function createOrder(db, input) {
    const orderNumber = `RCT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const timestamp = nowIso();
    const createdAt = input.created_at || timestamp;

    const result = db.prepare(`
        INSERT INTO orders (
            order_number, provider, provider_reference, status,
            customer_name, customer_email, amount_cents, currency,
            items_json, metadata_json, created_at, updated_at
        )
        VALUES (
            @order_number, @provider, @provider_reference, @status,
            @customer_name, @customer_email, @amount_cents, @currency,
            @items_json, @metadata_json, @created_at, @updated_at
        )
    `).run({
        order_number: orderNumber,
        provider: input.provider,
        provider_reference: input.provider_reference || null,
        status: input.status || "pending",
        customer_name: input.customer_name,
        customer_email: input.customer_email,
        amount_cents: input.amount_cents,
        currency: input.currency || "CHF",
        items_json: JSON.stringify(input.items),
        metadata_json: JSON.stringify(input.metadata || {}),
        created_at: createdAt,
        updated_at: timestamp,
    });

    return getOrderById(db, result.lastInsertRowid);
}

function listRecentOrders(db) {
    return db.prepare(`
        SELECT ${ORDER_COLUMNS}
        FROM orders
        ORDER BY created_at DESC
        LIMIT 10
    `).all().map(parseOrder);
}

function buildOrderFilterClause(filters = {}) {
    const conditions = [];
    const values = [];

    if (filters.status) {
        conditions.push("status = ?");
        values.push(filters.status);
    }

    if (filters.query) {
        conditions.push("(order_number LIKE ? OR customer_name LIKE ? OR customer_email LIKE ?)");
        const pattern = `%${filters.query}%`;
        values.push(pattern, pattern, pattern);
    }

    return {
        whereClause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
        values,
    };
}

function readPaginationLimit(value) {
    const limit = Number.parseInt(value, 10);
    if (!Number.isInteger(limit) || limit <= 0) {
        return 50;
    }

    return Math.min(limit, 100);
}

function readPaginationOffset(value) {
    const offset = Number.parseInt(value, 10);
    return Number.isInteger(offset) && offset > 0 ? offset : 0;
}

function listOrders(db, filters = {}) {
    const { whereClause, values } = buildOrderFilterClause(filters);
    const limit = readPaginationLimit(filters.limit);
    const offset = readPaginationOffset(filters.offset);

    return db.prepare(`
        SELECT ${ORDER_COLUMNS}
        FROM orders
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ?
        OFFSET ?
    `).all(...values, limit, offset).map(parseOrder);
}

function listStaleReservedExternalPaymentOrders(db, options = {}) {
    const cutoffIso = String(options.cutoffIso || "").trim();
    if (!cutoffIso) {
        return [];
    }

    const limit = readPaginationLimit(options.limit);

    return db.prepare(`
        SELECT ${ORDER_COLUMNS}
        FROM orders
        WHERE provider IN ('stripe', 'swissbitcoinpay')
          AND status = 'pending'
          AND json_extract(metadata_json, '$.inventory_reserved_at') IS NOT NULL
          AND json_extract(metadata_json, '$.inventory_released_at') IS NULL
          AND json_extract(metadata_json, '$.payment_recorded_at') IS NULL
          AND json_extract(metadata_json, '$.inventory_reserved_at') <= ?
        ORDER BY json_extract(metadata_json, '$.inventory_reserved_at') ASC, created_at ASC
        LIMIT ?
    `).all(cutoffIso, limit).map(parseOrder);
}

function countOrders(db, filters = {}) {
    const { whereClause, values } = buildOrderFilterClause(filters);

    return db.prepare(`
        SELECT COUNT(*) AS count
        FROM orders
        ${whereClause}
    `).get(...values).count;
}

function deleteOrder(db, orderId) {
    return db.prepare("DELETE FROM orders WHERE id = ?").run(orderId).changes > 0;
}

function parseOrder(order) {
    if (!order) {
        return null;
    }

    return {
        ...order,
        items: JSON.parse(order.items_json || "[]"),
        metadata: JSON.parse(order.metadata_json || "{}"),
    };
}

function getOrderById(db, orderId) {
    return parseOrder(db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).get(orderId));
}

function getOrderByNumber(db, orderNumber) {
    return parseOrder(db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE order_number = ?`).get(orderNumber));
}

function getOrderByProviderReference(db, provider, providerReference) {
    return parseOrder(
        db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE provider = ? AND provider_reference = ?`)
            .get(provider, providerReference)
    );
}

function updateOrderProviderReference(db, orderId, providerReference, metadata = null) {
    const current = getOrderById(db, orderId);
    if (!current) {
        return null;
    }

    const nextMetadata = metadata ? { ...current.metadata, ...metadata } : current.metadata;

    db.prepare(`
        UPDATE orders
        SET provider_reference = ?,
            metadata_json = ?,
            updated_at = ?
        WHERE id = ?
    `).run(providerReference, JSON.stringify(nextMetadata), nowIso(), orderId);

    return getOrderById(db, orderId);
}

function updateOrderStatus(db, orderId, status, metadata = null) {
    const current = getOrderById(db, orderId);
    if (!current) {
        return null;
    }

    const nextMetadata = metadata ? { ...current.metadata, ...metadata } : current.metadata;

    db.prepare(`
        UPDATE orders
        SET status = ?,
            metadata_json = ?,
            updated_at = ?
        WHERE id = ?
    `).run(status, JSON.stringify(nextMetadata), nowIso(), orderId);

    return getOrderById(db, orderId);
}

function updateOrderRecord(db, orderId, updates = {}) {
    const current = getOrderById(db, orderId);
    if (!current) {
        return null;
    }

    const nextStatus = updates.status || current.status;
    const nextMetadata = updates.metadata
        ? { ...current.metadata, ...updates.metadata }
        : current.metadata;
    const nextCreatedAt = updates.created_at || current.created_at;

    db.prepare(`
        UPDATE orders
        SET status = ?,
            metadata_json = ?,
            created_at = ?,
            updated_at = ?
        WHERE id = ?
    `).run(nextStatus, JSON.stringify(nextMetadata), nextCreatedAt, nowIso(), orderId);

    return getOrderById(db, orderId);
}

module.exports = {
    createOrder,
    listRecentOrders,
    listOrders,
    listStaleReservedExternalPaymentOrders,
    countOrders,
    deleteOrder,
    parseOrder,
    getOrderById,
    getOrderByNumber,
    getOrderByProviderReference,
    updateOrderProviderReference,
    updateOrderStatus,
    updateOrderRecord,
};
