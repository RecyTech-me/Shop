"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const { initializeDatabase, listAdminProducts, listAdmins } = require("../lib/db");
const { hashPassword } = require("../lib/auth");
const {
    getProductPriceRangeCents,
    hasActiveProductReservation,
    syncProductCategories,
} = require("../lib/repositories/products");

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
    const normalized = normalizeText(value);
    return normalized ? slugify(normalized).replace(/-/g, "") : "";
}

function nowIso() {
    return new Date().toISOString();
}

function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
}

function parseImportedInteger(value, { defaultValue = 0, minimum = 0, label }) {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
        return defaultValue;
    }

    const parsed = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new Error(`${label} invalide dans l'export WooCommerce.`);
    }

    return parsed;
}

function parseImportedMoneyToCents(value, label) {
    const normalized = String(value ?? "").trim().replace(",", ".");
    if (!normalized) {
        return 0;
    }

    if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
        throw new Error(`${label} invalide dans l'export WooCommerce.`);
    }

    const amountCents = Math.round(Number(normalized) * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
        throw new Error(`${label} invalide dans l'export WooCommerce.`);
    }

    return amountCents;
}

function parseImportedSourceId(value) {
    const normalized = String(value ?? "").trim();
    const parsed = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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
    const categories = uniqueStrings(
        (Array.isArray(sourceProduct.categories) ? sourceProduct.categories : [])
            .map((category) => normalizeText(category))
            .filter(Boolean)
    );

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
            const priceCents = rawPriceCents === null || rawPriceCents === undefined || rawPriceCents === ""
                ? null
                : parseImportedInteger(rawPriceCents, {
                    label: "Prix de configuration",
                });

            return {
                selections: selections.map((selection) => ({
                    name: normalizeText(selection.name),
                    value: normalizeText(selection.value),
                })),
                price_cents: priceCents,
            };
        })
        .filter((configuration) => configuration.selections.length === optionGroups.length);

    const priceCents = parseImportedMoneyToCents(sourceProduct.price_chf, "Prix du produit");

    return {
        name: normalizeText(sourceProduct.name),
        slug: normalizeText(sourceProduct.slug),
        category: categories[0] || "",
        categories_json: JSON.stringify(categories),
        short_description: normalizeText(sourceProduct.short_description),
        description: normalizeText(sourceProduct.description),
        image_url: imageUrl,
        image_gallery_json: JSON.stringify(galleryUrls),
        option_groups_json: JSON.stringify(optionGroups),
        info_rows_json: JSON.stringify(infoRows),
        valid_configurations_json: JSON.stringify(validConfigurations),
        price_cents: priceCents,
        ...getProductPriceRangeCents({
            price_cents: priceCents,
            valid_configurations: validConfigurations,
        }),
        currency: "CHF",
        inventory: parseImportedInteger(sourceProduct.inventory, {
            label: "Stock du produit",
        }),
        featured: sourceProduct.featured ? 1 : 0,
        published: sourceProduct.published ? 1 : 0,
        created_at: normalizeText(sourceProduct.created_at) || nowIso(),
        updated_at: normalizeText(sourceProduct.updated_at) || nowIso(),
        source_product_id: Number(sourceProduct.source_product_id) || null,
    };
}

function buildProductMatcher(existingProducts) {
    const eligibleProducts = existingProducts.filter((product) => !product.is_pack && product.product_kind !== "pack");
    const byId = new Map(eligibleProducts.map((product) => [product.id, product]));
    const bySlug = new Map();
    const byName = new Map();

    for (const product of eligibleProducts) {
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
        const sourceProductId = parseImportedSourceId(item.source_product_id);
        const sourceVariationId = parseImportedSourceId(item.source_variation_id);
        const mappedProductId = sourceProductId === null ? null : productIdMap.get(sourceProductId) || null;

        return {
            product_id: mappedProductId,
            source_product_id: sourceProductId,
            source_variation_id: sourceVariationId,
            name: normalizeText(item.name),
            quantity: parseImportedInteger(item.quantity, {
                defaultValue: 1,
                minimum: 1,
                label: "Quantité de ligne de commande",
            }),
            unit_price_cents: parseImportedInteger(item.unit_price_cents, {
                label: "Prix unitaire de ligne de commande",
            }),
            line_total_cents: parseImportedInteger(item.line_total_cents, {
                label: "Total de ligne de commande",
            }),
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

function validateExportedShop(exported) {
    if (!exported || typeof exported !== "object" || Array.isArray(exported)) {
        throw new Error("WooCommerce exporter returned an invalid JSON object.");
    }

    for (const field of ["products", "orders", "admins"]) {
        if (exported[field] !== undefined && !Array.isArray(exported[field])) {
            throw new Error(`WooCommerce exporter field ${field} must be an array.`);
        }
    }

    return exported;
}

function importExportedShop(db, exported, options = {}) {
    validateExportedShop(exported);
    const timestamp = options.now || nowIso;
    const randomBytes = options.randomBytes || crypto.randomBytes;
    const passwordHasher = options.hashPassword || hashPassword;
    const stats = {
        source: exported.source,
        products: { created: 0, updated: 0, skipped: 0 },
        orders: { created: 0, skipped: 0 },
        admins: { created: 0, skipped: 0 },
        imported_admin_credentials: [],
        run_at: timestamp(),
    };

    const existingProducts = listAdminProducts(db);
    const matcher = buildProductMatcher(existingProducts);
    const productIdMap = new Map();

    const upsertProduct = db.prepare(`
        UPDATE products
        SET slug = @slug,
            name = @name,
            category = @category,
            categories_json = @categories_json,
            short_description = @short_description,
            description = @description,
            image_url = @image_url,
            image_gallery_json = @image_gallery_json,
            option_groups_json = @option_groups_json,
            info_rows_json = @info_rows_json,
            valid_configurations_json = @valid_configurations_json,
            price_cents = @price_cents,
            starting_price_cents = @starting_price_cents,
            maximum_price_cents = @maximum_price_cents,
            currency = @currency,
            inventory = @inventory,
            featured = @featured,
            published = @published,
            updated_at = @updated_at
        WHERE id = @id
    `);

    const insertProduct = db.prepare(`
        INSERT INTO products (
            slug, name, category, categories_json, short_description, description, image_url,
            image_gallery_json, option_groups_json, info_rows_json, valid_configurations_json,
            price_cents, starting_price_cents, maximum_price_cents, currency, inventory, featured, published,
            created_at, updated_at
        )
        VALUES (
            @slug, @name, @category, @categories_json, @short_description, @description, @image_url,
            @image_gallery_json, @option_groups_json, @info_rows_json, @valid_configurations_json,
            @price_cents, @starting_price_cents, @maximum_price_cents, @currency, @inventory, @featured, @published,
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
                if (hasActiveProductReservation(db, existing.id)) {
                    throw new Error(`Le produit ${existing.name} a une réservation active et ne peut pas être mis à jour par l'import.`);
                }

                upsertProduct.run({
                    ...payload,
                    id: existing.id,
                    slug: nextSlug,
                    updated_at: payload.updated_at || timestamp(),
                });
                syncProductCategories(db, existing.id, JSON.parse(payload.categories_json));

                const sourceProductId = parseImportedSourceId(sourceProduct.source_product_id);
                if (sourceProductId !== null) {
                    productIdMap.set(sourceProductId, existing.id);
                }
                matcher.remember({ ...existing, slug: nextSlug, name: payload.name });
                stats.products.updated += 1;
                continue;
            }

            const result = insertProduct.run({
                ...payload,
                slug: nextSlug,
                created_at: payload.created_at || timestamp(),
                updated_at: payload.updated_at || timestamp(),
            });
            syncProductCategories(db, result.lastInsertRowid, JSON.parse(payload.categories_json));

            const sourceProductId = parseImportedSourceId(sourceProduct.source_product_id);
            if (sourceProductId !== null) {
                productIdMap.set(sourceProductId, result.lastInsertRowid);
            }
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

            const temporaryPassword = randomBytes(9).toString("base64url");
            insertAdmin.run(username, passwordHasher(temporaryPassword), "admin", timestamp());
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
                        created_at: timestamp(),
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
                amount_cents: parseImportedInteger(order.amount_cents, {
                    label: "Montant de commande",
                }),
                currency: normalizeText(order.currency) || "CHF",
                items_json: JSON.stringify(mapImportedOrderItems(order.items, productIdMap)),
                metadata_json: JSON.stringify(metadata),
                created_at: normalizeText(order.created_at) || timestamp(),
                updated_at: normalizeText(order.updated_at) || normalizeText(order.created_at) || timestamp(),
            });

            stats.orders.created += 1;
        }

        options.beforeCommit?.(stats);
    });

    runImport();

    return stats;
}

function parseExporterOutput(exporterOutput) {
    try {
        return validateExportedShop(JSON.parse(exporterOutput));
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`WooCommerce exporter returned invalid JSON: ${error.message}`, { cause: error });
        }
        throw error;
    }
}

function redactImportStats(stats) {
    const { imported_admin_credentials: credentials = [], ...publicStats } = stats;
    return {
        ...publicStats,
        imported_admin_credentials_count: credentials.length,
    };
}

function runImporter(options = {}) {
    const argv = options.argv || process.argv.slice(2);
    const env = options.env || process.env;
    const executeExporter = options.execFileSync || execFileSync;
    const openDatabase = options.initializeDatabase || initializeDatabase;
    const args = parseArgs(argv);
    if (!args.wpRoot || !args.sqlite) {
        throw new Error("Usage: node scripts/import-wordpress-shop.js --wp-root /path/to/wordpress --sqlite /path/to/shop.db [--report /path/to/report.json]");
    }

    const projectRoot = path.resolve(__dirname, "..");
    const exporterPath = path.join(__dirname, "export-woocommerce-data.php");
    const exporterOutput = executeExporter("php", [exporterPath, args.wpRoot], {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
    });
    const exported = parseExporterOutput(exporterOutput);
    if ((exported.admins || []).length && !args.report) {
        throw new Error("--report is required when importing administrators so temporary passwords are stored securely.");
    }
    const reportPath = args.report ? path.resolve(args.report) : "";
    const reportTempPath = reportPath
        ? path.join(
            path.dirname(reportPath),
            `.${path.basename(reportPath)}.${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`
        )
        : "";
    if (reportPath) {
        ensureDirectory(reportPath);
    }
    const db = openDatabase(path.resolve(args.sqlite), env);
    let importCommitted = false;

    try {
        const stats = importExportedShop(db, exported, {
            ...(options.importOptions || {}),
            beforeCommit(currentStats) {
                options.importOptions?.beforeCommit?.(currentStats);
                if (!reportTempPath) {
                    return;
                }

                fs.writeFileSync(reportTempPath, JSON.stringify(currentStats, null, 2), {
                    encoding: "utf8",
                    mode: 0o600,
                });
                fs.chmodSync(reportTempPath, 0o600);
            },
        });
        importCommitted = true;

        if (reportTempPath) {
            try {
                fs.renameSync(reportTempPath, reportPath);
            } catch (error) {
                throw new Error(
                    `Import committed, but the credential report could not be promoted. Recover it from ${reportTempPath}: ${error.message}`,
                    { cause: error }
                );
            }
        }

        return stats;
    } catch (error) {
        if (!importCommitted && reportTempPath) {
            fs.rmSync(reportTempPath, { force: true });
        }
        throw error;
    } finally {
        db.close?.();
    }
}

function main() {
    require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

    const stats = runImporter();
    process.stdout.write(`${JSON.stringify(redactImportStats(stats), null, 2)}\n`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
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
};
