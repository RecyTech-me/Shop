const { ORDER_STATUS_OPTIONS } = require("./shop-formatters");
const {
    isInventoryHoldingOrderStatus,
    isPaidOrderStatus,
} = require("./order-statuses");

function createManualOrderService(deps) {
    const {
        db,
        normalizeText,
        normalizeSingleLineText,
        parseInteger,
        parseMoneyToCents,
        parseOptionalMoneyToCents,
        normalizeOrderDateTimeField,
        normalizePromoCode,
        readSelectedProductOptions,
        ensureAvailableProductQuantity,
        validateRequestedServiceTags,
        getProductUnitPriceCents,
        getConfigurationAvailableQuantity,
        productCategoryList,
        snapshotPackBundleItems,
        getPromoCodeOutcome,
        getPromoCodeLabel,
        getProductById,
        createOrder,
        markOrderPaid,
        reserveOrderInventory,
        updateOrderRecord,
    } = deps;

    function readManualOrderInput(values) {
        const productId = parseInteger(values.product_id, Number.NaN);
        const quantity = parseInteger(values.quantity || "1", Number.NaN);
        const customerName = normalizeSingleLineText(values.customer_name);
        const customerEmail = normalizeSingleLineText(values.customer_email);
        const customerPhone = normalizeSingleLineText(values.customer_phone);
        const paymentLabel = normalizeSingleLineText(values.payment_label) || "Vente hors site";
        const status = normalizeText(values.status) || "paid";
        const internalNote = normalizeText(values.internal_note);
        const priceOverrideRaw = String(values.unit_price_chf || "").trim();
        const unitPriceOverrideCents = priceOverrideRaw ? parseMoneyToCents(priceOverrideRaw, Number.NaN) : null;
        const discountRaw = String(values.discount_chf || "").trim();
        const discountCents = discountRaw ? parseMoneyToCents(discountRaw, Number.NaN) : 0;
        const receivedAmountCents = parseOptionalMoneyToCents(values.actual_received_chf, "Montant réellement reçu");
        const createdAt = normalizeOrderDateTimeField(values.order_created_at, new Date().toISOString());
        const promoCode = normalizePromoCode(values.promo_code);
        const serviceTags = [...new Set(
            (Array.isArray(values.service_tags) ? values.service_tags : [values.service_tags])
                .map((tag) => normalizeSingleLineText(tag))
                .filter(Boolean)
        )];

        if (!customerName) {
            throw new Error("Le nom du client est obligatoire.");
        }

        if (!Number.isInteger(productId) || productId <= 0) {
            throw new Error("Produit invalide.");
        }

        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
            throw new Error("Quantité invalide.");
        }

        if (!ORDER_STATUS_OPTIONS.some((option) => option.value === status)) {
            throw new Error("Statut de commande invalide.");
        }

        if (unitPriceOverrideCents !== null && (!Number.isFinite(unitPriceOverrideCents) || unitPriceOverrideCents < 0)) {
            throw new Error("Prix unitaire invalide.");
        }

        if (!Number.isFinite(discountCents) || discountCents < 0) {
            throw new Error("Remise invalide.");
        }

        return {
            productId,
            quantity,
            customerName,
            customerEmail,
            customerPhone,
            paymentLabel,
            status,
            internalNote,
            unitPriceOverrideCents,
            createdAt,
            discountCents,
            receivedAmountCents,
            promoCode,
            serviceTags,
        };
    }

    function buildManualOrderDiscount(input, subtotalCents) {
        const manualDiscountCents = input.discountCents || 0;
        const promoOutcome = input.promoCode ? getPromoCodeOutcome(input.promoCode, subtotalCents) : null;

        if (manualDiscountCents > subtotalCents) {
            throw new Error("La remise ne peut pas dépasser le total des articles.");
        }

        if (promoOutcome?.error && manualDiscountCents <= 0) {
            throw new Error(promoOutcome.error);
        }

        const discountCents = manualDiscountCents > 0
            ? manualDiscountCents
            : promoOutcome?.discountCents || 0;
        const promoCode = promoOutcome?.code || input.promoCode || "";
        const validPromoCode = promoOutcome && !promoOutcome.error ? promoOutcome.promoCode : null;
        const label = promoCode
            ? getPromoCodeLabel({ code: promoCode })
            : "Remise manuelle";

        return {
            discountCents,
            discountLine: discountCents > 0
                ? {
                    type: "discount",
                    code: promoCode,
                    label,
                    amount_cents: -discountCents,
                }
                : null,
            promo: promoCode
                ? {
                    id: validPromoCode?.id || null,
                    code: promoCode,
                    description: validPromoCode?.description || "",
                    discount_type: validPromoCode?.discount_type || (manualDiscountCents > 0 ? "manual" : ""),
                    discount_value: validPromoCode?.discount_value || discountCents,
                    discount_cents: discountCents,
                    label,
                    manual_override: manualDiscountCents > 0,
                }
                : null,
        };
    }

    function buildManualOrderItem(product, input) {
        const selectedOptions = Array.isArray(input.selectedOptions) ? input.selectedOptions : [];
        const unitPriceCents = input.unitPriceOverrideCents ?? getProductUnitPriceCents(product, selectedOptions);
        const availableQuantity = getConfigurationAvailableQuantity(product, selectedOptions);

        return {
            product_id: product.id,
            item_key: `manual:${product.id}:${JSON.stringify(selectedOptions)}:${Date.now()}`,
            slug: product.slug,
            name: product.name,
            product_kind: product.product_kind,
            is_pack: Boolean(product.is_pack),
            category: product.category,
            categories: productCategoryList(product),
            short_description: product.short_description,
            image_url: product.image_url,
            selected_options: selectedOptions,
            service_tags: Array.isArray(input.serviceTags) ? input.serviceTags : [],
            bundle_items: snapshotPackBundleItems(product),
            quantity: input.quantity,
            unit_price_cents: unitPriceCents,
            line_total_cents: unitPriceCents * input.quantity,
            inventory: availableQuantity,
        };
    }

    function finalizeManualOrderStatus(order, targetStatus, metadata) {
        if (isInventoryHoldingOrderStatus(targetStatus)) {
            const reservedOrder = reserveOrderInventory(db, order.id, metadata);

            if (targetStatus === "pending") {
                return reservedOrder;
            }

            return updateOrderRecord(db, reservedOrder.id, {
                status: targetStatus,
            });
        }

        if (!isPaidOrderStatus(targetStatus)) {
            return updateOrderRecord(db, order.id, {
                status: targetStatus,
                metadata,
            });
        }

        const paidOrder = markOrderPaid(db, order.id, metadata);
        if (targetStatus === "paid") {
            return paidOrder;
        }

        return updateOrderRecord(db, paidOrder.id, {
            status: targetStatus,
        });
    }

    function createManualOrder(values, currentAdmin = null) {
        const input = readManualOrderInput(values);
        const product = getProductById(db, input.productId);

        if (!product) {
            throw new Error("Produit introuvable.");
        }

        if (product.inventory <= 0) {
            throw new Error("Ce produit est en rupture de stock.");
        }

        const selectedOptions = readSelectedProductOptions(product, values);
        ensureAvailableProductQuantity(product, selectedOptions, input.quantity);
        const serviceTags = validateRequestedServiceTags(product, selectedOptions, input.serviceTags, input.quantity);
        const item = buildManualOrderItem(product, { ...input, selectedOptions, serviceTags });
        const discount = buildManualOrderDiscount(input, item.line_total_cents);
        const amountCents = Math.max(0, item.line_total_cents - discount.discountCents);
        const metadata = {
            checkout: {
                customer_first_name: input.customerName,
                shipping_phone: input.customerPhone,
            },
            delivery: {
                method: "manual",
                label: "Vente hors site",
                amount_cents: 0,
            },
            additions: discount.discountLine ? [discount.discountLine] : [],
            promo: discount.promo,
            manual: {
                created_by_admin_id: currentAdmin?.id || null,
                created_by_admin_username: currentAdmin?.username || "",
                payment_label: input.paymentLabel,
                discount_cents: discount.discountCents,
            },
            payment: input.receivedAmountCents === null
                ? {}
                : {
                    received_amount_cents: input.receivedAmountCents,
                    received_amount_recorded_at: new Date().toISOString(),
                },
            admin: {
                internal_note: input.internalNote,
                customer_note: "",
                fulfillment_note: "",
                carrier: "",
                tracking_number: "",
                pickup_details: "",
            },
        };

        return db.transaction(() => {
            const order = createOrder(db, {
                provider: "manual",
                provider_reference: null,
                customer_name: input.customerName,
                customer_email: input.customerEmail,
                amount_cents: amountCents,
                currency: product.currency || "CHF",
                items: [item],
                status: "pending",
                metadata,
                created_at: input.createdAt,
            });

            return finalizeManualOrderStatus(order, input.status, metadata);
        }).immediate();
    }

    return {
        createManualOrder,
        readManualOrderInput,
        buildManualOrderDiscount,
        buildManualOrderItem,
        finalizeManualOrderStatus,
    };
}

module.exports = { createManualOrderService };
