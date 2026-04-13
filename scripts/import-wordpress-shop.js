"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { initializeDatabase, listAdminProducts, listAdmins } = require("../lib/db");
const { hashPassword } = require("../lib/auth");

function parseArgs(argv) {
    const args = {
        wpRoot: "",
        sqlite: "",
        report: "",
    };

    for (let index = 0; index < argv.length; index += 1) {
        const current = argv[index];
        const next = argv[index + 1];

        if (current === "--wp-root" && next) {
            args.wpRoot = next;
            index += 1;
            continue;
        }

        if (current === "--sqlite" && next) {
            args.sqlite = next;
            index += 1;
            continue;
        }

        if (current === "--report" && next) {
            args.report = next;
            index += 1;
            continue;
        }
    }

    return args;
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

function normalizeText(value) {
    return String(value || "").trim();
}

function slugify(value) {
    return normalizeText(value)
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/[-\s]+/g, "-")
        .replace(/^-+|-+$/g, "") || "produit";
}

function normalizeMatchKey(value) {
    return slugify(value).replace(/-/g, "");
}

function nowIso() {
    return new Date().toISOString();
}

function formatOptionGroups(groups) {
    return (groups || [])
        .map((group) => `${group.name}: ${(group.values || []).join(" | ")}`)
        .join("\n");
}

function formatInfoRows(rows) {
    return (rows || [])
        .map((row) => `${row.label}: ${row.value}`)
        .join("\n");
}

function formatValidConfigurations(configurations) {
    return (configurations || [])
        .map((configuration) => {
            const selections = Array.isArray(configuration)
                ? configuration
                : Array.isArray(configuration?.selections)
                    ? configuration.selections
                    : [];
            const priceCents = Number.isInteger(configuration?.price_cents)
                ? configuration.price_cents
                : null;
            const selectionText = selections.map((selection) => `${selection.name}=${selection.value}`).join(" ; ");

            return priceCents === null
                ? selectionText
                : `${selectionText} => ${(priceCents / 100).toFixed(2)}`;
        })
        .filter(Boolean)
        .join("\n");
}

function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
}

function makeUniqueSlug(db, desiredSlug, productId = null) {
    const baseSlug = slugify(desiredSlug);
    let candidate = baseSlug;
    let suffix = 2;

    while (true) {
        const existing = productId
            ? db.prepare("SELECT id FROM products WHERE slug = ? AND id != ?").get(candidate, productId)
            : db.prepare("SELECT id FROM products WHERE slug = ?").get(candidate);

        if (!existing) {
            return candidate;
        }

        candidate = `${baseSlug}-${suffix}`;
        suffix += 1;
    }
}

function buildProductPayload(sourceProduct) {
    const infoRows = [...(Array.isArray(sourceProduct.info_rows) ? sourceProduct.info_rows : [])];
    const categories = Array.isArray(sourceProduct.categories) ? sourceProduct.categories.filter(Boolean) : [];

    if (categories.length && !infoRows.some((row) => normalizeText(row.label).toLowerCase() === "catégories")) {
        infoRows.push({
            label: "Catégories",
            value: categories.join(", "),
        });
    }

    const imageUrl = normalizeText(sourceProduct.image_url);
    const galleryUrls = uniqueStrings(
        (Array.isArray(sourceProduct.gallery_urls) ? sourceProduct.gallery_urls : [])
            .map((url) => normalizeText(url))
            .filter((url) => url && url !== imageUrl)
    );

    const optionGroups = (Array.isArray(sourceProduct.option_groups) ? sourceProduct.option_groups : [])
        .map((group) => ({
            name: normalizeText(group.name),
            values: uniqueStrings((Array.isArray(group.values) ? group.values : []).map((value) => normalizeText(value))),
        }))
        .filter((group) => group.name && group.values.length);

    const validConfigurations = (Array.isArray(sourceProduct.valid_configurations) ? sourceProduct.valid_configurations : [])
        .map((configuration) => {
            const selections = Array.isArray(configuration)
                ? configuration
                : Array.isArray(configuration?.selections)
                    ? configuration.selections
                    : [];
            const rawPriceCents = !Array.isArray(configuration) ? configuration?.price_cents : null;
            const priceCents = Number.parseInt(rawPriceCents, 10);

            return {
                selections: selections.map((selection) => ({
                    name: normalizeText(selection.name),
                    value: normalizeText(selection.value),
                })),
                price_cents: Number.isInteger(priceCents) && priceCents >= 0 ? priceCents : null,
            };
        })
        .filter((configuration) => configuration.selections.length === optionGroups.length);

    return {
        name: normalizeText(sourceProduct.name),
        slug: normalizeText(sourceProduct.slug),
        short_description: normalizeText(sourceProduct.short_description),
        description: normalizeText(sourceProduct.description),
        image_url: imageUrl,
        image_gallery_json: JSON.stringify(galleryUrls),
        option_groups_json: JSON.stringify(optionGroups),
        info_rows_json: JSON.stringify(infoRows),
        valid_configurations_json: JSON.stringify(validConfigurations),
        price_cents: Math.max(0, Math.round(Number(sourceProduct.price_chf || 0) * 100)),
        currency: "CHF",
        inventory: Math.max(0, Number.parseInt(sourceProduct.inventory || "0", 10) || 0),
        featured: sourceProduct.featured ? 1 : 0,
        published: sourceProduct.published ? 1 : 0,
        created_at: normalizeText(sourceProduct.created_at) || nowIso(),
        updated_at: normalizeText(sourceProduct.updated_at) || nowIso(),
        source_product_id: Number(sourceProduct.source_product_id) || null,
    };
}

function buildProductMatcher(existingProducts) {
    const byId = new Map(existingProducts.map((product) => [product.id, product]));
    const bySlug = new Map();
    const byName = new Map();

    for (const product of existingProducts) {
        const slugKey = normalizeMatchKey(product.slug);
        const nameKey = normalizeMatchKey(product.name);

        if (slugKey && !bySlug.has(slugKey)) {
            bySlug.set(slugKey, product.id);
        }

        if (nameKey && !byName.has(nameKey)) {
            byName.set(nameKey, product.id);
        }
    }

    return {
        find(sourceProduct) {
            const slugKey = normalizeMatchKey(sourceProduct.slug);
            if (slugKey && bySlug.has(slugKey)) {
                return byId.get(bySlug.get(slugKey)) || null;
            }

            const nameKey = normalizeMatchKey(sourceProduct.name);
            if (nameKey && byName.has(nameKey)) {
                return byId.get(byName.get(nameKey)) || null;
            }

            return null;
        },
        remember(product) {
            byId.set(product.id, product);
            if (product.slug) {
                bySlug.set(normalizeMatchKey(product.slug), product.id);
            }
            if (product.name) {
                byName.set(normalizeMatchKey(product.name), product.id);
            }
        },
    };
}

function mapImportedOrderItems(items, productIdMap) {
    return (Array.isArray(items) ? items : []).map((item) => {
        const mappedProductId = productIdMap.get(Number(item.source_product_id)) || null;

        return {
            product_id: mappedProductId,
            source_product_id: Number(item.source_product_id) || null,
            source_variation_id: Number(item.source_variation_id) || null,
            name: normalizeText(item.name),
            quantity: Math.max(1, Number.parseInt(item.quantity || "1", 10) || 1),
            unit_price_cents: Math.max(0, Number.parseInt(item.unit_price_cents || "0", 10) || 0),
            line_total_cents: Math.max(0, Number.parseInt(item.line_total_cents || "0", 10) || 0),
            selected_options: Array.isArray(item.selected_options)
                ? item.selected_options
                    .map((selection) => ({
                        name: normalizeText(selection.name),
                        value: normalizeText(selection.value),
                    }))
                    .filter((selection) => selection.name && selection.value)
                : [],
        };
    });
}

function ensureDirectory(targetPath) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.wpRoot || !args.sqlite) {
        fail("Usage: node scripts/import-wordpress-shop.js --wp-root /path/to/wordpress --sqlite /path/to/shop.db [--report /path/to/report.json]");
    }

    const projectRoot = path.resolve(__dirname, "..");
    const exporterPath = path.join(__dirname, "export-woocommerce-data.php");
    const exporterOutput = execFileSync("php", [exporterPath, args.wpRoot], {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
    });

    const exported = JSON.parse(exporterOutput);
    const db = initializeDatabase(path.resolve(args.sqlite), process.env);

    const stats = {
        source: exported.source,
        products: { created: 0, updated: 0, skipped: 0 },
        orders: { created: 0, skipped: 0 },
        admins: { created: 0, skipped: 0 },
        imported_admin_credentials: [],
        run_at: nowIso(),
    };

    const existingProducts = listAdminProducts(db);
    const matcher = buildProductMatcher(existingProducts);
    const productIdMap = new Map();

    const upsertProduct = db.prepare(`
        UPDATE products
        SET slug = @slug,
            name = @name,
            short_description = @short_description,
            description = @description,
            image_url = @image_url,
            image_gallery_json = @image_gallery_json,
            option_groups_json = @option_groups_json,
            info_rows_json = @info_rows_json,
            valid_configurations_json = @valid_configurations_json,
            price_cents = @price_cents,
            currency = @currency,
            inventory = @inventory,
            featured = @featured,
            published = @published,
            updated_at = @updated_at
        WHERE id = @id
    `);

    const insertProduct = db.prepare(`
        INSERT INTO products (
            slug, name, short_description, description, image_url,
            image_gallery_json, option_groups_json, info_rows_json, valid_configurations_json,
            price_cents, currency, inventory, featured, published,
            created_at, updated_at
        )
        VALUES (
            @slug, @name, @short_description, @description, @image_url,
            @image_gallery_json, @option_groups_json, @info_rows_json, @valid_configurations_json,
            @price_cents, @currency, @inventory, @featured, @published,
            @created_at, @updated_at
        )
    `);

    const insertOrder = db.prepare(`
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
    `);

    const insertAdmin = db.prepare(`
        INSERT INTO admins (username, password_hash, role, created_at)
        VALUES (?, ?, ?, ?)
    `);

    const runImport = db.transaction(() => {
        for (const sourceProduct of exported.products || []) {
            const payload = buildProductPayload(sourceProduct);
            if (!payload.name) {
                stats.products.skipped += 1;
                continue;
            }

            const existing = matcher.find(sourceProduct);
            const nextSlug = makeUniqueSlug(db, payload.slug || payload.name, existing?.id || null);
            if (existing) {
                upsertProduct.run({
                    ...payload,
                    id: existing.id,
                    slug: nextSlug,
                    updated_at: payload.updated_at || nowIso(),
                });

                productIdMap.set(Number(sourceProduct.source_product_id), existing.id);
                matcher.remember({ ...existing, slug: nextSlug, name: payload.name });
                stats.products.updated += 1;
                continue;
            }

            const result = insertProduct.run({
                ...payload,
                slug: nextSlug,
                created_at: payload.created_at || nowIso(),
                updated_at: payload.updated_at || nowIso(),
            });

            productIdMap.set(Number(sourceProduct.source_product_id), result.lastInsertRowid);
            matcher.remember({ id: result.lastInsertRowid, slug: nextSlug, name: payload.name });
            stats.products.created += 1;
        }

        const existingAdmins = new Set(listAdmins(db).map((admin) => admin.username));
        for (const admin of exported.admins || []) {
            const username = normalizeText(admin.username);
            if (!username || existingAdmins.has(username)) {
                stats.admins.skipped += 1;
                continue;
            }

            const temporaryPassword = crypto.randomBytes(9).toString("base64url");
            insertAdmin.run(username, hashPassword(temporaryPassword), "admin", nowIso());
            existingAdmins.add(username);
            stats.admins.created += 1;
            stats.imported_admin_credentials.push({
                username,
                email: normalizeText(admin.email),
                temporary_password: temporaryPassword,
            });
        }

        for (const order of exported.orders || []) {
            const orderNumber = normalizeText(order.order_number);
            if (!orderNumber) {
                stats.orders.skipped += 1;
                continue;
            }

            const existingOrder = db.prepare("SELECT id FROM orders WHERE order_number = ?").get(orderNumber);
            if (existingOrder) {
                stats.orders.skipped += 1;
                continue;
            }

            const metadata = {
                ...(order.metadata || {}),
                admin_events: [
                    {
                        kind: "update",
                        actor: "Import WooCommerce",
                        created_at: nowIso(),
                        note: `Commande importée depuis WooCommerce #${order.source_order_id}`,
                    },
                ],
            };

            insertOrder.run({
                order_number: orderNumber,
                provider: normalizeText(order.provider) || "manual",
                provider_reference: normalizeText(order.provider_reference) || null,
                status: normalizeText(order.status) || "pending",
                customer_name: normalizeText(order.customer_name) || "Client WooCommerce",
                customer_email: normalizeText(order.customer_email),
                amount_cents: Math.max(0, Number.parseInt(order.amount_cents || "0", 10) || 0),
                currency: normalizeText(order.currency) || "CHF",
                items_json: JSON.stringify(mapImportedOrderItems(order.items, productIdMap)),
                metadata_json: JSON.stringify(metadata),
                created_at: normalizeText(order.created_at) || nowIso(),
                updated_at: normalizeText(order.updated_at) || normalizeText(order.created_at) || nowIso(),
            });

            stats.orders.created += 1;
        }
    });

    runImport();

    if (args.report) {
        const reportPath = path.resolve(args.report);
        ensureDirectory(reportPath);
        fs.writeFileSync(reportPath, JSON.stringify(stats, null, 2));
    }

    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
}

main();
