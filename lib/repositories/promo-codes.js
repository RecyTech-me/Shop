function nowIso() {
    return new Date().toISOString();
}

function normalizePromoCodeValue(value) {
    return String(value || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
}

function parsePromoCode(promoCode) {
    if (!promoCode) {
        return null;
    }

    const discountValue = Number(promoCode.discount_value || 0);

    return {
        ...promoCode,
        code: normalizePromoCodeValue(promoCode.code),
        active: promoCode.active === 1,
        discount_percent: promoCode.discount_type === "percent" ? discountValue : null,
        discount_cents: promoCode.discount_type === "fixed" ? discountValue : null,
    };
}

function listPromoCodes(db) {
    return db.prepare(`
        SELECT *
        FROM promo_codes
        ORDER BY created_at DESC, id DESC
    `).all().map(parsePromoCode);
}

function getPromoCodeById(db, promoCodeId) {
    return parsePromoCode(db.prepare("SELECT * FROM promo_codes WHERE id = ?").get(promoCodeId));
}

function getPromoCodeByCode(db, code) {
    return parsePromoCode(
        db.prepare("SELECT * FROM promo_codes WHERE code = ?").get(normalizePromoCodeValue(code))
    );
}

function createPromoCode(db, input) {
    const timestamp = nowIso();
    const result = db.prepare(`
        INSERT INTO promo_codes (
            code,
            description,
            discount_type,
            discount_value,
            minimum_order_cents,
            max_redemptions,
            times_redeemed,
            starts_on,
            expires_on,
            active,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        normalizePromoCodeValue(input.code),
        input.description || "",
        input.discount_type,
        input.discount_value,
        input.minimum_order_cents || 0,
        input.max_redemptions ?? null,
        input.times_redeemed || 0,
        input.starts_on || null,
        input.expires_on || null,
        input.active ? 1 : 0,
        timestamp,
        timestamp
    );

    return getPromoCodeById(db, result.lastInsertRowid);
}

function updatePromoCode(db, promoCodeId, input) {
    const existing = getPromoCodeById(db, promoCodeId);
    if (!existing) {
        return null;
    }

    db.prepare(`
        UPDATE promo_codes
        SET code = ?,
            description = ?,
            discount_type = ?,
            discount_value = ?,
            minimum_order_cents = ?,
            max_redemptions = ?,
            starts_on = ?,
            expires_on = ?,
            active = ?,
            updated_at = ?
        WHERE id = ?
    `).run(
        normalizePromoCodeValue(input.code),
        input.description || "",
        input.discount_type,
        input.discount_value,
        input.minimum_order_cents || 0,
        input.max_redemptions ?? null,
        input.starts_on || null,
        input.expires_on || null,
        input.active ? 1 : 0,
        nowIso(),
        promoCodeId
    );

    return getPromoCodeById(db, promoCodeId);
}

function deletePromoCode(db, promoCodeId) {
    return db.prepare("DELETE FROM promo_codes WHERE id = ?").run(promoCodeId).changes > 0;
}

module.exports = {
    listPromoCodes,
    getPromoCodeById,
    getPromoCodeByCode,
    createPromoCode,
    updatePromoCode,
    deletePromoCode,
};
