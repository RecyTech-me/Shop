function nowIso() {
    return new Date().toISOString();
}

function parseSiteReview(review) {
    if (!review) {
        return null;
    }

    return {
        ...review,
        rating: Math.min(5, Math.max(1, Number.parseInt(review.rating, 10) || 1)),
        approved: review.approved === 1,
    };
}

function listApprovedSiteReviews(db) {
    return db.prepare(`
        SELECT *
        FROM site_reviews
        WHERE approved = 1
        ORDER BY created_at DESC, id DESC
    `).all().map(parseSiteReview);
}

function getSiteReviewSummary(db) {
    const summary = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(AVG(rating), 0) AS average_rating
        FROM site_reviews
        WHERE approved = 1
    `).get();

    return {
        count: summary.count,
        averageRating: Number(summary.average_rating || 0),
    };
}

function listPendingSiteReviews(db) {
    return db.prepare(`
        SELECT *
        FROM site_reviews
        WHERE approved = 0
        ORDER BY created_at ASC, id ASC
    `).all().map(parseSiteReview);
}

function countPendingSiteReviews(db) {
    return db.prepare("SELECT COUNT(*) AS count FROM site_reviews WHERE approved = 0").get().count;
}

function createSiteReview(db, input) {
    const timestamp = nowIso();
    const result = db.prepare(`
        INSERT INTO site_reviews (
            rating, reviewer_name, reviewer_email, title, body, approved, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
        input.rating,
        input.reviewer_name,
        input.reviewer_email || "",
        input.title || "",
        input.body,
        timestamp,
        timestamp
    );

    return parseSiteReview(db.prepare("SELECT * FROM site_reviews WHERE id = ?").get(result.lastInsertRowid));
}

function approveSiteReview(db, reviewId) {
    db.prepare(`
        UPDATE site_reviews
        SET approved = 1,
            updated_at = ?
        WHERE id = ?
    `).run(nowIso(), reviewId);

    return parseSiteReview(db.prepare("SELECT * FROM site_reviews WHERE id = ?").get(reviewId));
}

function deleteSiteReview(db, reviewId) {
    return db.prepare("DELETE FROM site_reviews WHERE id = ?").run(reviewId).changes > 0;
}

module.exports = {
    listApprovedSiteReviews,
    getSiteReviewSummary,
    listPendingSiteReviews,
    countPendingSiteReviews,
    createSiteReview,
    approveSiteReview,
    deleteSiteReview,
};
