const session = require("express-session");

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const SESSION_CLEANUP_INTERVAL_MS = 1000 * 60 * 30;

class SqliteSessionStore extends session.Store {
    constructor(database, options = {}) {
        super();
        this.db = database;
        this.ttlMs = options.ttlMs || SESSION_TTL_MS;

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                sid TEXT PRIMARY KEY,
                sess TEXT NOT NULL,
                expired_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_expired_at
            ON sessions (expired_at);
        `);

        this.getSession = this.db.prepare("SELECT sess, expired_at FROM sessions WHERE sid = ?");
        this.upsertSession = this.db.prepare(`
            INSERT INTO sessions (sid, sess, expired_at)
            VALUES (@sid, @sess, @expired_at)
            ON CONFLICT(sid) DO UPDATE SET
                sess = excluded.sess,
                expired_at = excluded.expired_at
        `);
        this.touchSession = this.db.prepare("UPDATE sessions SET expired_at = ? WHERE sid = ?");
        this.destroySession = this.db.prepare("DELETE FROM sessions WHERE sid = ?");
        this.deleteExpiredSessions = this.db.prepare("DELETE FROM sessions WHERE expired_at <= ?");
        this.countSessions = this.db.prepare("SELECT COUNT(*) AS count FROM sessions");

        const cleanupInterval = options.cleanupIntervalMs ?? SESSION_CLEANUP_INTERVAL_MS;
        if (cleanupInterval > 0) {
            this.cleanupTimer = setInterval(() => this.pruneExpiredSessions(), cleanupInterval);
            this.cleanupTimer.unref?.();
        }

        this.pruneExpiredSessions();
    }

    getExpiry(sessionData) {
        const cookieExpires = Date.parse(sessionData?.cookie?.expires || "");
        if (Number.isFinite(cookieExpires)) {
            return cookieExpires;
        }

        const maxAge = Number(sessionData?.cookie?.originalMaxAge);
        if (Number.isFinite(maxAge) && maxAge > 0) {
            return Date.now() + maxAge;
        }

        return Date.now() + this.ttlMs;
    }

    pruneExpiredSessions() {
        try {
            this.deleteExpiredSessions.run(Date.now());
        } catch (error) {
            console.warn(`[session] Failed to prune expired sessions: ${error.message}`);
        }
    }

    get(sid, callback) {
        try {
            const row = this.getSession.get(sid);
            if (!row) {
                return callback(null, null);
            }

            if (row.expired_at <= Date.now()) {
                this.destroySession.run(sid);
                return callback(null, null);
            }

            return callback(null, JSON.parse(row.sess));
        } catch (error) {
            return callback(error);
        }
    }

    set(sid, sessionData, callback = () => {}) {
        try {
            this.upsertSession.run({
                sid,
                sess: JSON.stringify(sessionData),
                expired_at: this.getExpiry(sessionData),
            });
            return callback(null);
        } catch (error) {
            return callback(error);
        }
    }

    touch(sid, sessionData, callback = () => {}) {
        try {
            const result = this.touchSession.run(this.getExpiry(sessionData), sid);
            if (!result.changes) {
                return this.set(sid, sessionData, callback);
            }

            return callback(null);
        } catch (error) {
            return callback(error);
        }
    }

    destroy(sid, callback = () => {}) {
        try {
            this.destroySession.run(sid);
            return callback(null);
        } catch (error) {
            return callback(error);
        }
    }

    length(callback) {
        try {
            return callback(null, this.countSessions.get().count);
        } catch (error) {
            return callback(error);
        }
    }

    clear(callback = () => {}) {
        try {
            this.db.prepare("DELETE FROM sessions").run();
            return callback(null);
        } catch (error) {
            return callback(error);
        }
    }
}

module.exports = {
    SqliteSessionStore,
    SESSION_TTL_MS,
};
