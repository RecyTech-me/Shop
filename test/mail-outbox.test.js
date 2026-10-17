const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { createMailOutbox } = require("../lib/mail-outbox");

function setup(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mail-outbox-"));
    const filename = path.join(directory, "shop.db");
    const connections = [];
    function connect() {
        const db = new Database(filename);
        db.pragma("foreign_keys = ON");
        connections.push(db);
        return db;
    }
    const db = connect();
    db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
        CREATE TABLE mail_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('team','customer')),
            status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
            sent_at INTEGER, last_error TEXT NOT NULL DEFAULT '', UNIQUE(order_id,kind)
        ); INSERT INTO orders VALUES (1, 'pending');`);
    let time = 1000;
    const deliveries = [];
    const logs = [];
    const make = (connection = db, overrides = {}) => createMailOutbox({
        db: connection,
        getOrderById: (id) => connection.prepare("SELECT * FROM orders WHERE id = ?").get(id),
        sendOrderMail: async (order, kind) => { deliveries.push([order.id, kind]); },
        logger: { warn: (...args) => logs.push(args) },
        now: () => time,
        ...options,
        ...overrides,
    });
    t.after(() => {
        for (const connection of connections) if (connection.open) connection.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { db, connect, make, deliveries, logs, advance: (duration) => { time += duration; } };
}

test("outbox deduplicates each recipient and survives database reopen", async (t) => {
    const fixture = setup(t);
    const queue = fixture.make();
    queue.enqueueOrder({ id: 1 });
    queue.enqueueOrder({ id: 1 });
    assert.equal(queue.listForOrder(1).length, 2);
    fixture.db.close();
    const restored = fixture.make(fixture.connect());
    await restored.processPending();
    assert.deepEqual(fixture.deliveries, [[1, "team"], [1, "customer"]]);
    assert.ok(restored.listForOrder(1).every((job) => job.status === "sent"));
    restored.enqueueOrder({ id: 1 });
    assert.equal(restored.retryOrder(1), 0);
    await restored.processPending();
    assert.equal(fixture.deliveries.length, 2);
});

test("outbox retries on schedule, caps failures, redacts errors, and permits manual retry", async (t) => {
    let fail = true;
    const fixture = setup(t, { sendOrderMail: async () => {
        if (fail) throw Object.assign(new Error("secret@example.test password=private"), { code: "EAUTH" });
    } });
    const queue = fixture.make();
    queue.enqueueOrder({ id: 1 });
    await queue.processPending();
    assert.equal(queue.listForOrder(1)[0].attempts, 1);
    await queue.processPending();
    assert.equal(queue.listForOrder(1)[0].attempts, 1);
    for (const delay of [60_000, 120_000, 240_000, 480_000]) {
        fixture.advance(delay);
        await queue.processPending();
    }
    assert.ok(queue.listForOrder(1).every((job) => job.status === "failed" && job.attempts === 5));
    assert.match(queue.listForOrder(1)[0].last_error, /EAUTH/);
    assert.doesNotMatch(JSON.stringify([queue.listForOrder(1), fixture.logs]), /secret|password|private/);
    fixture.advance(24 * 60 * 60 * 1000);
    await queue.processPending();
    assert.equal(queue.listForOrder(1)[0].attempts, 5);
    fail = false;
    assert.equal(queue.retryOrder(1), 2);
    await queue.processPending();
    assert.ok(queue.listForOrder(1).every((job) => job.status === "sent" && job.attempts === 1));
});

test("team failure does not block customer confirmation and unknown errors are sanitized", async (t) => {
    const fixture = setup(t, { sendOrderMail: async (_order, kind) => {
        if (kind === "team") throw Object.assign(new Error("customer@example.test"), { code: "customer@example.test" });
    } });
    const queue = fixture.make();
    queue.enqueueOrder({ id: 1 });
    await queue.processPending();
    const [team, customer] = queue.listForOrder(1);
    assert.equal(team.status, "pending");
    assert.equal(customer.status, "sent");
    assert.doesNotMatch(JSON.stringify([team, fixture.logs]), /customer@example/);
    assert.equal(queue.retryOrder(1), 1);
});

test("independent processors claim a job only once while SMTP is pending", async (t) => {
    const fixture = setup(t);
    let release;
    let started;
    const waiting = new Promise((resolve) => { release = resolve; });
    const firstStarted = new Promise((resolve) => { started = resolve; });
    const deliveries = [];
    const sendOrderMail = async (_order, kind) => {
        deliveries.push(kind);
        if (kind === "team") { started(); await waiting; }
    };
    const first = fixture.make(fixture.db, { sendOrderMail });
    const second = fixture.make(fixture.connect(), { sendOrderMail });
    first.enqueueOrder({ id: 1 });
    const processing = first.processPending();
    await firstStarted;
    assert.equal(first.retryOrder(1), 1); // Only the customer job is pending.
    await second.processPending();
    release();
    await processing;
    assert.deepEqual(deliveries, ["team", "customer"]);
    assert.ok(first.listForOrder(1).every((job) => job.status === "sent"));
});

test("expired leases recover after a crash and stop after the fifth attempt", async (t) => {
    const fixture = setup(t);
    const queue = fixture.make();
    queue.enqueueOrder({ id: 1 });
    fixture.db.prepare(`UPDATE mail_outbox SET status = 'processing', attempts = 4,
        lease_token = 'dead-process', lease_until = 2000 WHERE kind = 'team'`).run();
    await queue.processPending();
    assert.deepEqual(fixture.deliveries, [[1, "customer"]]);
    fixture.advance(1000);
    await queue.processPending();
    assert.deepEqual(fixture.deliveries, [[1, "customer"], [1, "team"]]);
    fixture.db.prepare(`UPDATE mail_outbox SET status = 'processing', attempts = 5,
        lease_token = 'dead-process', lease_until = 2000 WHERE kind = 'team'`).run();
    await queue.processPending();
    assert.equal(queue.listForOrder(1)[0].status, "failed");
    assert.equal(fixture.deliveries.length, 2);
});

test("cancelled orders are skipped and deletion removes queued messages", async (t) => {
    const fixture = setup(t);
    const queue = fixture.make();
    queue.enqueueOrder({ id: 1 });
    fixture.db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = 1").run();
    await queue.processPending();
    assert.equal(fixture.deliveries.length, 0);
    assert.ok(queue.listForOrder(1).every((job) => job.status === "cancelled"));
    fixture.db.prepare("DELETE FROM orders WHERE id = 1").run();
    assert.deepEqual(queue.listForOrder(1), []);
});

test("each pass processes at most ten messages", async (t) => {
    const fixture = setup(t);
    const queue = fixture.make();
    for (let id = 1; id <= 7; id += 1) {
        if (id > 1) fixture.db.prepare("INSERT INTO orders VALUES (?, 'pending')").run(id);
        queue.enqueueOrder({ id });
    }
    await queue.processPending();
    assert.equal(fixture.deliveries.length, 10);
    await queue.processPending();
    assert.equal(fixture.deliveries.length, 14);
});

test("an expired worker cannot overwrite a newer worker's successful delivery", async (t) => {
    const fixture = setup(t);
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const first = fixture.make(fixture.db, { sendOrderMail: async () => {
        await waiting;
        throw new Error("old connection failed");
    } });
    first.enqueueOrder({ id: 1 });
    const oldWorker = first.processPending();
    fixture.advance(5 * 60 * 1000);
    const replacement = fixture.make(fixture.connect());
    await replacement.processPending();
    release();
    await oldWorker;
    const [team, customer] = replacement.listForOrder(1);
    assert.equal(team.status, "sent");
    assert.equal(team.attempts, 2);
    assert.equal(customer.status, "sent");
    assert.equal(team.last_error, "");
    assert.ok(!Object.hasOwn(team, "lease_token"));
});
