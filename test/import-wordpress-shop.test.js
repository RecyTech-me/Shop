const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    createOrder,
    createProduct,
    initializeDatabase,
    listProductCategories,
    listPublishedProducts,
    reserveOrderInventory,
} = require("../lib/db");
const {
    buildProductMatcher,
    buildProductPayload,
    importExportedShop,
    makeUniqueSlug,
    mapImportedOrderItems,
    normalizeMatchKey,
    parseArgs,
    parseExporterOutput,
    parseImportedInteger,
    parseImportedMoneyToCents,
    parseImportedSourceId,
    redactImportStats,
    runImporter,
    slugify,
    validateExportedShop,
} = require("../scripts/import-wordpress-shop");

const FIXED_NOW = "2026-07-21T12:00:00.000Z";

function createTempDatabase(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-wordpress-import-"));
    const databasePath = path.join(directory, "shop.db");
    const db = initializeDatabase(databasePath, {
        NODE_ENV: "test",
        ADMIN_USERNAME: "seed-admin",
        ADMIN_PASSWORD: "seed-admin-password",
    });

    t.after(() => {
        if (db.open) {
            db.close();
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });

    return { db, databasePath, directory };
}

function createExport(overrides = {}) {
    return {
        source: "https://wordpress.example.test",
        products: [
            {
                source_product_id: 10,
                name: "Produit Éco",
                slug: "",
                price_chf: "12.34",
                inventory: "5",
                categories: ["Occasion", "Occasion", "Mobilité"],
                image_url: "https://example.test/main.jpg",
                gallery_urls: [
                    "https://example.test/main.jpg",
                    "https://example.test/detail.jpg",
                    "https://example.test/detail.jpg",
                ],
                option_groups: [{ name: "Couleur", values: ["Vert", "Vert", "Bleu"] }],
                valid_configurations: [{
                    selections: [{ name: "Couleur", value: "Vert" }],
                    price_cents: "1450",
                }],
                published: true,
            },
            { source_product_id: 11, name: "", slug: "ignored" },
        ],
        admins: [
            { username: "seed-admin", email: "seed@example.test" },
            { username: "imported-admin", email: "imported@example.test" },
            { username: "", email: "missing@example.test" },
        ],
        orders: [
            {
                source_order_id: 501,
                order_number: "WC-501",
                provider: "manual",
                status: "paid",
                customer_name: "Ada Client",
                customer_email: "ada@example.test",
                amount_cents: "2468",
                currency: "CHF",
                items: [{
                    source_product_id: 10,
                    source_variation_id: 12,
                    name: "Produit Éco",
                    quantity: "2",
                    unit_price_cents: "1234",
                    line_total_cents: "2468",
                    selected_options: [
                        { name: "Couleur", value: "Vert" },
                        { name: "", value: "Ignored" },
                    ],
                }],
                metadata: { imported: true },
            },
            { source_order_id: 502, order_number: "" },
        ],
        ...overrides,
    };
}

test("WordPress import argument and slug helpers normalize expected values", () => {
    assert.deepEqual(parseArgs([
        "--wp-root", "/srv/wordpress",
        "--unknown", "ignored",
        "--sqlite", "/srv/shop.db",
        "--report", "/srv/report.json",
    ]), {
        wpRoot: "/srv/wordpress",
        sqlite: "/srv/shop.db",
        report: "/srv/report.json",
    });
    assert.equal(slugify("  Produit Éco + Test  "), "produit-eco-test");
    assert.equal(slugify(""), "produit");
    assert.equal(normalizeMatchKey(""), "");
    assert.equal(normalizeMatchKey("Produit Éco"), "produiteco");
});

test("product matcher never treats an empty source slug as the fallback slug produit", () => {
    const existing = { id: 1, slug: "produit", name: "Ancien produit" };
    const matcher = buildProductMatcher([existing]);

    assert.equal(matcher.find({ slug: "", name: "Nouveau produit" }), null);
    assert.equal(matcher.find({ slug: "PRODUIT", name: "Different" }), existing);

    const remembered = { id: 2, slug: "nouveau", name: "Nouveau produit" };
    matcher.remember(remembered);
    assert.equal(matcher.find({ slug: "", name: "nouveau produit" }), remembered);

    const pack = { id: 3, slug: "starter-pack", name: "Starter pack", product_kind: "pack", is_pack: true };
    assert.equal(buildProductMatcher([pack]).find({ slug: "starter-pack", name: "Starter pack" }), null);
});

test("product payload and imported order items sanitize exporter data", () => {
    const payload = buildProductPayload(createExport().products[0]);
    assert.equal(payload.price_cents, 1234);
    assert.equal(payload.starting_price_cents, 1450);
    assert.equal(payload.maximum_price_cents, 1450);
    assert.equal(payload.inventory, 5);
    assert.deepEqual(JSON.parse(payload.categories_json), ["Occasion", "Mobilité"]);
    assert.deepEqual(JSON.parse(payload.image_gallery_json), ["https://example.test/detail.jpg"]);
    assert.deepEqual(JSON.parse(payload.option_groups_json), [{ name: "Couleur", values: ["Vert", "Bleu"] }]);
    assert.equal(JSON.parse(payload.info_rows_json)[0].label, "Catégories");
    assert.throws(
        () => buildProductPayload({ name: "Invalid price", price_chf: "not-a-number" }),
        /Prix du produit invalide/
    );
    assert.throws(
        () => buildProductPayload({ name: "Invalid stock", inventory: "5units" }),
        /Stock du produit invalide/
    );

    const mappedItems = mapImportedOrderItems(createExport().orders[0].items, new Map([[10, 99]]));
    assert.equal(mappedItems[0].product_id, 99);
    assert.equal(mappedItems[0].quantity, 2);
    assert.deepEqual(mappedItems[0].selected_options, [{ name: "Couleur", value: "Vert" }]);
    assert.deepEqual(mapImportedOrderItems(null, new Map()), []);
    assert.throws(
        () => mapImportedOrderItems([{ quantity: "2units" }], new Map()),
        /Quantité de ligne de commande invalide/
    );
    assert.equal(parseImportedInteger("12", { label: "Entier" }), 12);
    assert.throws(() => parseImportedInteger("12px", { label: "Entier" }), /Entier invalide/);
    assert.equal(parseImportedMoneyToCents("12,34", "Prix"), 1234);
    assert.throws(() => parseImportedMoneyToCents("12 CHF", "Prix"), /Prix invalide/);

    const malformedSourceIdItems = mapImportedOrderItems([
        { name: "Unmapped", quantity: 1, unit_price_cents: 100, line_total_cents: 100 },
        { source_product_id: "10", name: "Mapped", quantity: 1, unit_price_cents: 100, line_total_cents: 100 },
    ], new Map([[10, 99], [Number.NaN, 404]]));
    assert.equal(malformedSourceIdItems[0].product_id, null);
    assert.equal(malformedSourceIdItems[0].source_product_id, null);
    assert.equal(malformedSourceIdItems[1].product_id, 99);
    assert.equal(parseImportedSourceId("10"), 10);
    assert.equal(parseImportedSourceId("10junk"), null);
    assert.equal(parseImportedSourceId("999999999999999999999"), null);
});

test("unique slug generation increments collisions and excludes the updated product", (t) => {
    const { db } = createTempDatabase(t);
    const insert = db.prepare(`
        INSERT INTO products (slug, name, price_cents, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?)
    `);
    const firstId = Number(insert.run("produit", "Produit", FIXED_NOW, FIXED_NOW).lastInsertRowid);
    insert.run("produit-2", "Produit 2", FIXED_NOW, FIXED_NOW);

    assert.equal(makeUniqueSlug(db, "Produit"), "produit-3");
    assert.equal(makeUniqueSlug(db, "Produit", firstId), "produit");
});

test("exporter output validation rejects malformed JSON and invalid collection fields", () => {
    assert.deepEqual(validateExportedShop({ products: [], orders: [], admins: [] }), {
        products: [],
        orders: [],
        admins: [],
    });
    assert.throws(() => validateExportedShop(null), /invalid JSON object/);
    assert.throws(() => validateExportedShop({ products: {} }), /products must be an array/);
    assert.throws(() => parseExporterOutput("not-json"), /returned invalid JSON/);
    assert.deepEqual(parseExporterOutput('{"products":[]}'), { products: [] });
});

test("transactional WordPress import creates records and is idempotent on rerun", (t) => {
    const { db } = createTempDatabase(t);
    const exported = createExport();
    const importOptions = {
        now: () => FIXED_NOW,
        randomBytes: () => Buffer.from("temporary"),
        hashPassword: (password) => `hashed:${password}`,
    };

    const first = importExportedShop(db, exported, importOptions);
    assert.deepEqual(first.products, { created: 1, updated: 0, skipped: 1 });
    assert.deepEqual(first.orders, { created: 1, skipped: 1 });
    assert.deepEqual(first.admins, { created: 1, skipped: 2 });
    assert.equal(first.imported_admin_credentials[0].username, "imported-admin");
    assert.equal(first.run_at, FIXED_NOW);

    const product = db.prepare(`
        SELECT id, slug, price_cents, starting_price_cents, maximum_price_cents, inventory
        FROM products
        WHERE name = ?
    `).get("Produit Éco");
    const order = db.prepare("SELECT items_json, metadata_json FROM orders WHERE order_number = ?").get("WC-501");
    const importedAdmin = db.prepare("SELECT password_hash, role FROM admins WHERE username = ?").get("imported-admin");
    assert.equal(product.slug, "produit-eco");
    assert.equal(product.price_cents, 1234);
    assert.equal(product.starting_price_cents, 1450);
    assert.equal(product.maximum_price_cents, 1450);
    assert.equal(product.inventory, 5);
    assert.deepEqual(listProductCategories(db), ["Mobilité", "Occasion"]);
    assert.equal(listPublishedProducts(db, { minPriceCents: 1400 }).length, 1);
    assert.equal(JSON.parse(order.items_json)[0].product_id, product.id);
    assert.equal(JSON.parse(order.metadata_json).admin_events[0].actor, "Import WooCommerce");
    assert.equal(importedAdmin.role, "admin");
    assert.match(importedAdmin.password_hash, /^hashed:/);

    exported.products[0].price_chf = "15.00";
    const second = importExportedShop(db, exported, importOptions);
    assert.deepEqual(second.products, { created: 0, updated: 1, skipped: 1 });
    assert.deepEqual(second.orders, { created: 0, skipped: 2 });
    assert.deepEqual(second.admins, { created: 0, skipped: 3 });
    assert.equal(db.prepare("SELECT price_cents FROM products WHERE id = ?").get(product.id).price_cents, 1500);
});

test("transactional WordPress import rolls back all records on failure", (t) => {
    const { db } = createTempDatabase(t);
    const circularMetadata = {};
    circularMetadata.self = circularMetadata;
    const exported = createExport({
        orders: [{ order_number: "ROLLBACK", metadata: circularMetadata }],
        admins: [],
    });

    assert.throws(() => importExportedShop(db, exported, { now: () => FIXED_NOW }));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM products WHERE name = ?").get("Produit Éco").count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE order_number = ?").get("ROLLBACK").count, 0);
});

test("WordPress import refuses to overwrite a product with an active reservation", (t) => {
    const { db } = createTempDatabase(t);
    const product = createProduct(db, {
        product_kind: "product",
        name: "Produit Éco",
        price_chf: "10.00",
        inventory: "2",
        published: "1",
    });
    const order = createOrder(db, {
        provider: "stripe",
        provider_reference: "pi_import_reservation",
        customer_name: "Client",
        customer_email: "client@example.test",
        amount_cents: 1000,
        items: [{
            product_id: product.id,
            name: product.name,
            quantity: 1,
            selected_options: [],
        }],
        status: "pending",
        metadata: {},
    });
    reserveOrderInventory(db, order.id);

    assert.throws(
        () => importExportedShop(db, createExport({ admins: [], orders: [] }), { now: () => FIXED_NOW }),
        /réservation active.*import/
    );
    assert.equal(db.prepare("SELECT price_cents FROM products WHERE id = ?").get(product.id).price_cents, 1000);
});

test("import rolls back if its pre-commit credential report step fails", (t) => {
    const { db } = createTempDatabase(t);

    assert.throws(() => importExportedShop(db, createExport({ admins: [] }), {
        now: () => FIXED_NOW,
        beforeCommit: () => {
            throw new Error("report storage failed");
        },
    }), /report storage failed/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM products WHERE name = ?").get("Produit Éco").count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE order_number = ?").get("WC-501").count, 0);
});

test("CLI importer validates required arguments and exporter JSON before opening SQLite", () => {
    assert.throws(() => runImporter({ argv: [] }), /Usage:/);

    let databaseOpened = false;
    assert.throws(() => runImporter({
        argv: ["--wp-root", "/tmp/wp", "--sqlite", "/tmp/shop.db"],
        execFileSync: () => "invalid-json",
        initializeDatabase: () => {
            databaseOpened = true;
        },
    }), /returned invalid JSON/);
    assert.equal(databaseOpened, false);

    assert.throws(() => runImporter({
        argv: ["--wp-root", "/tmp/wp", "--sqlite", "/tmp/shop.db"],
        execFileSync: () => JSON.stringify({ products: [], orders: [], admins: [{ username: "admin" }] }),
        initializeDatabase: () => {
            databaseOpened = true;
        },
    }), /--report is required/);
    assert.equal(databaseOpened, false);
});

test("import stats redact temporary administrator passwords for stdout", () => {
    const redacted = redactImportStats({
        products: { created: 0 },
        imported_admin_credentials: [{ username: "admin", temporary_password: "secret" }],
    });

    assert.deepEqual(redacted, {
        products: { created: 0 },
        imported_admin_credentials_count: 1,
    });
    assert.doesNotMatch(JSON.stringify(redacted), /secret/);
});

test("CLI importer writes reports and always closes the database", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-wordpress-runner-"));
    const reportPath = path.join(directory, "reports", "import.json");
    const databasePath = path.join(directory, "shop.db");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    let openedDb;
    const stats = runImporter({
        argv: ["--wp-root", "/srv/wordpress", "--sqlite", databasePath, "--report", reportPath],
        env: {
            NODE_ENV: "test",
            ADMIN_USERNAME: "seed-admin",
            ADMIN_PASSWORD: "seed-admin-password",
        },
        execFileSync: (command, args, options) => {
            assert.equal(command, "php");
            assert.equal(args[1], "/srv/wordpress");
            assert.equal(options.encoding, "utf8");
            return JSON.stringify({ source: "fixture", products: [], orders: [], admins: [] });
        },
        initializeDatabase: (target, env) => {
            openedDb = initializeDatabase(target, env);
            return openedDb;
        },
        importOptions: { now: () => FIXED_NOW },
    });

    assert.equal(stats.source, "fixture");
    assert.equal(openedDb.open, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")), stats);
    assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);

    let closedAfterFailure = false;
    assert.throws(() => runImporter({
        argv: ["--wp-root", "/srv/wordpress", "--sqlite", databasePath],
        execFileSync: () => JSON.stringify({ products: [], orders: [], admins: [] }),
        initializeDatabase: () => ({
            prepare() {
                throw new Error("database read failed");
            },
            close() {
                closedAfterFailure = true;
            },
        }),
    }), /database read failed/);
    assert.equal(closedAfterFailure, true);
});
