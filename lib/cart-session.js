const {
    findProductConfiguration,
    getConfigurationAvailableQuantity,
} = require("./product-normalizers");

function createCartSessionHelpers(options) {
    const {
        db,
        getProductById,
        normalizeText,
        normalizeSingleLineText,
        productCategoryList,
    } = options;

    function getCartItems(req) {
        return Array.isArray(req.session.cart) ? req.session.cart : [];
    }

    function setCartItems(req, items) {
        req.session.cart = items;
    }

    function ensureAvailableProductQuantity(product, selectedOptions = [], requestedQuantity = 1) {
        const availableQuantity = getConfigurationAvailableQuantity(product, selectedOptions);

        if (availableQuantity <= 0) {
            throw new Error(product.option_groups?.length
                ? "Cette combinaison d'options est en rupture de stock."
                : "Ce produit est en rupture de stock.");
        }

        if (requestedQuantity > availableQuantity) {
            throw new Error(`Stock insuffisant : ${availableQuantity} unité(s) disponible(s).`);
        }

        return availableQuantity;
    }

    function validateRequestedServiceTags(product, selectedOptions = [], requestedServiceTags = [], requestedQuantity = 1) {
        const configuration = findProductConfiguration(product, selectedOptions);
        const availableServiceTags = Array.isArray(configuration?.service_tags)
            ? [...new Set(configuration.service_tags.map((tag) => normalizeSingleLineText(tag)).filter(Boolean))]
            : [];
        const normalizedRequestedTags = [...new Set(
            (Array.isArray(requestedServiceTags) ? requestedServiceTags : [requestedServiceTags])
                .map((tag) => normalizeSingleLineText(tag))
                .filter(Boolean)
        )];

        if (!normalizedRequestedTags.length && !availableServiceTags.length) {
            return [];
        }

        if (normalizedRequestedTags.some((tag) => !availableServiceTags.includes(tag))) {
            throw new Error("Le ou les tags de service choisis ne correspondent pas à cette combinaison.");
        }

        if (normalizedRequestedTags.length > requestedQuantity) {
            throw new Error("Le nombre de tags de service choisis dépasse la quantité vendue.");
        }

        const requiredTagCount = Math.min(requestedQuantity, availableServiceTags.length);
        if (requiredTagCount > 0 && normalizedRequestedTags.length !== requiredTagCount) {
            throw new Error(requiredTagCount === 1
                ? "Veuillez choisir le tag de service vendu."
                : `Veuillez choisir exactement ${requiredTagCount} tags de service.`);
        }

        return normalizedRequestedTags;
    }

    function getProductUnitPriceCents(product, selectedOptions = []) {
        if (product?.is_pack) {
            return product.price_cents;
        }

        const configurations = Array.isArray(product.valid_configurations)
            ? product.valid_configurations
            : [];

        if (!configurations.length) {
            return product.price_cents;
        }

        const configuration = findProductConfiguration(product, selectedOptions);
        if (!configuration) {
            throw new Error("Cette combinaison d'options n'est pas disponible.");
        }

        return Number.isInteger(configuration.price_cents)
            ? configuration.price_cents
            : product.price_cents;
    }

    function snapshotPackBundleItems(product) {
        if (!product?.is_pack || !Array.isArray(product.bundle_items)) {
            return [];
        }

        return product.bundle_items.map((item) => ({
            product_id: item.product_id,
            slug: item.slug,
            name: item.name,
            quantity: item.quantity,
            selected_options: Array.isArray(item.selected_options)
                ? item.selected_options.map((option) => ({ ...option }))
                : [],
            service_tags: [],
        }));
    }

    function buildCart(req) {
        const rawItems = getCartItems(req);
        const items = [];

        for (const rawItem of rawItems) {
            const product = getProductById(db, rawItem.productId);
            if (!product || !product.published) {
                continue;
            }

            const selectedOptions = Array.isArray(rawItem.selectedOptions)
                ? rawItem.selectedOptions
                    .map((option) => ({
                        name: normalizeText(option?.name),
                        value: normalizeText(option?.value),
                    }))
                    .filter((option) => option.name && option.value)
                : [];
            let unitPriceCents = product.price_cents;
            let availableQuantity = product.inventory;

            try {
                unitPriceCents = getProductUnitPriceCents(product, selectedOptions);
                availableQuantity = getConfigurationAvailableQuantity(product, selectedOptions);
            } catch {
                continue;
            }

            if (availableQuantity <= 0) {
                continue;
            }

            const requestedQuantity = Number(rawItem.quantity);
            const safeRequestedQuantity = Number.isSafeInteger(requestedQuantity) && requestedQuantity > 0
                ? requestedQuantity
                : 1;
            const quantity = Math.min(safeRequestedQuantity, availableQuantity);

            items.push({
                product_id: product.id,
                item_key: rawItem.itemKey || `${product.id}:${JSON.stringify(selectedOptions)}`,
                slug: product.slug,
                name: product.name,
                product_kind: product.product_kind,
                is_pack: Boolean(product.is_pack),
                category: product.category,
                categories: productCategoryList(product),
                short_description: product.short_description,
                image_url: product.image_url,
                selected_options: selectedOptions,
                bundle_items: snapshotPackBundleItems(product),
                quantity,
                unit_price_cents: unitPriceCents,
                line_total_cents: unitPriceCents * quantity,
                inventory: availableQuantity,
            });
        }

        const subtotalCents = items.reduce((sum, item) => sum + item.line_total_cents, 0);

        return {
            items,
            subtotalCents,
            itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        };
    }

    function makeCartItemKey(productId, selectedOptions = []) {
        return `${productId}:${JSON.stringify(selectedOptions)}`;
    }

    function invalidateCheckoutState(req) {
        delete req.session.checkoutAttemptId;
        delete req.session.completedCheckoutAttempt;
        delete req.session.stripeDraft;
    }

    function upsertCartItem(req, productId, quantity, selectedOptions = []) {
        const cart = getCartItems(req);
        invalidateCheckoutState(req);
        const parsedQuantity = Number(quantity);
        const safeQuantity = Number.isSafeInteger(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1;
        const itemKey = makeCartItemKey(productId, selectedOptions);
        const existing = cart.find((item) => (item.itemKey || makeCartItemKey(item.productId, item.selectedOptions || [])) === itemKey);

        if (existing) {
            existing.quantity = safeQuantity;
        } else {
            cart.push({ productId, quantity: safeQuantity, selectedOptions, itemKey });
        }

        setCartItems(req, cart);
    }

    function removeCartItem(req, itemKey) {
        invalidateCheckoutState(req);
        setCartItems(
            req,
            getCartItems(req).filter((item) => (item.itemKey || makeCartItemKey(item.productId, item.selectedOptions || [])) !== itemKey)
        );
    }

    return {
        getCartItems,
        setCartItems,
        getConfigurationAvailableQuantity,
        ensureAvailableProductQuantity,
        validateRequestedServiceTags,
        getProductUnitPriceCents,
        snapshotPackBundleItems,
        buildCart,
        makeCartItemKey,
        invalidateCheckoutState,
        upsertCartItem,
        removeCartItem,
    };
}

module.exports = { createCartSessionHelpers };
