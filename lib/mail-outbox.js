const { randomUUID } = require("node:crypto");

const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60 * 1000;
const SAFE_ERROR_CODES = new Set([
    "ETIMEDOUT", "ECONNECTION", "ECONNREFUSED", "ECONNRESET", "EDNS", "ENOTFOUND",
    "EAUTH", "EENVELOPE", "EMESSAGE", "ESOCKET", "ETLS", "ECONFIG",
]);

function safeMailError(error) {
    return SAFE_ERROR_CODES.has(error?.code)
        ? `Échec de l’envoi (${error.code}).`
        : "Échec de l’envoi. Vérifiez la configuration e-mail et réessayez.";
}

/** Durable at-least-once delivery: SMTP acceptance followed by a process crash can cause a duplicate. */
function createMailOutbox({ db, sendOrderMail, getOrderById, logger = console, now = Date.now }) {
    const insert = db.prepare("INSERT OR IGNORE INTO mail_outbox (order_id, kind, next_attempt_at) VALUES (?, ?, ?)");
    const enqueue = db.transaction((orderId) => {
        const timestamp = now();
        insert.run(orderId, "team", timestamp);
        insert.run(orderId, "customer", timestamp);
    });
    const candidates = db.prepare(`
        SELECT id, order_id, kind FROM mail_outbox
        WHERE attempts < ? AND next_attempt_at <= ?
          AND (status = 'pending' OR (status = 'processing' AND lease_until <= ?))
        ORDER BY next_attempt_at, id LIMIT 10
    `);
    const claim = db.prepare(`
        UPDATE mail_outbox SET status = 'processing', attempts = attempts + 1, lease_token = ?, lease_until = ?
        WHERE id = ? AND attempts < ? AND next_attempt_at <= ?
          AND (status = 'pending' OR (status = 'processing' AND lease_until <= ?))
        RETURNING attempts
    `);
    const finish = db.prepare(`
        UPDATE mail_outbox SET status = ?, next_attempt_at = ?, sent_at = ?, last_error = ?,
            lease_token = NULL, lease_until = NULL
        WHERE id = ? AND lease_token = ? AND status = 'processing'
    `);
    const list = db.prepare(`
        SELECT kind, status, attempts, next_attempt_at, sent_at, last_error
        FROM mail_outbox WHERE order_id = ? ORDER BY id
    `);
    const retry = db.prepare(`
        UPDATE mail_outbox SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = '',
            lease_token = NULL, lease_until = NULL
        WHERE order_id = ? AND status IN ('pending', 'failed')
    `);
    let processing = false;

    async function processPending() {
        if (processing) return;
        processing = true;
        try {
            const timestamp = now();
            // A crash during the final attempt must not leave a job processing forever.
            db.prepare(`UPDATE mail_outbox SET status = 'failed', lease_token = NULL, lease_until = NULL,
                last_error = 'Envoi interrompu après le nombre maximal de tentatives.'
                WHERE status = 'processing' AND attempts >= ? AND lease_until <= ?`).run(MAX_ATTEMPTS, timestamp);
            for (const job of candidates.all(MAX_ATTEMPTS, timestamp, timestamp)) {
                const token = randomUUID();
                const claimedAt = now();
                const claimed = claim.get(token, claimedAt + LEASE_MS, job.id, MAX_ATTEMPTS, claimedAt, claimedAt);
                if (!claimed) continue;
                const { attempts } = claimed;
                try {
                    const order = getOrderById(job.order_id);
                    if (!order || ["cancelled", "failed", "refunded"].includes(order.status)) {
                        finish.run("cancelled", 0, null, "", job.id, token);
                        continue;
                    }
                    await sendOrderMail(order, job.kind);
                    finish.run("sent", 0, now(), "", job.id, token);
                } catch (error) {
                    const safeError = safeMailError(error);
                    const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
                    const retryAt = status === "failed" ? 0 : now() + 60_000 * (2 ** (attempts - 1));
                    finish.run(status, retryAt, null, safeError, job.id, token);
                    logger.warn?.("order_mail_delivery_failed", { orderId: job.order_id, kind: job.kind, attempts, error: safeError });
                }
            }
        } finally {
            processing = false;
        }
    }

    return {
        enqueueOrder: (order) => enqueue(order.id),
        processPending,
        listForOrder: (orderId) => list.all(orderId),
        retryOrder: (orderId) => retry.run(now(), orderId).changes,
    };
}

module.exports = { createMailOutbox };
