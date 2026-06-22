const { getLegalPages } = require("../lib/legal-pages");

function registerStorefrontRoutes(deps) {
    const {
        app,
        db,
        render,
        setFlash,
        saveSessionAndRedirect,
        getSafeRedirectTarget,
        normalizeText,
        parseMoneyToCents,
        readSiteReviewInput,
        readSelectedProductOptions,
        ensureAvailableProductQuantity,
        upsertCartItem,
        getCartItems,
        makeCartItemKey,
        removeCartItem,
        productMetaDescription,
        productStructuredData,
        organizationStructuredData,
        listPublishedProducts,
        listProductCategories,
        listApprovedSiteReviews,
        getSiteReviewSummary,
        createSiteReview,
        getProductBySlug,
        getProductById,
    } = deps;

    function readCatalogueFilters(values) {
        const priceMin = normalizeText(values.price_min);
        const priceMax = normalizeText(values.price_max);
        const minPriceCents = parseMoneyToCents(priceMin, Number.NaN);
        const maxPriceCents = parseMoneyToCents(priceMax, Number.NaN);
        const availability = normalizeText(values.availability);
        const sort = normalizeText(values.sort) || "random";
        const allowedAvailability = new Set(["", "in_stock", "out_of_stock"]);
        const allowedSorts = new Set(["random", "featured", "newest", "price_asc", "price_desc", "name_asc"]);

        const view = {
            q: normalizeText(values.q),
            category: normalizeText(values.category),
            price_min: priceMin,
            price_max: priceMax,
            availability: allowedAvailability.has(availability) ? availability : "",
            sort: allowedSorts.has(sort) ? sort : "random",
        };

        return {
            view,
            productFilters: {
                query: view.q,
                category: view.category,
                minPriceCents: Number.isFinite(minPriceCents) ? minPriceCents : null,
                maxPriceCents: Number.isFinite(maxPriceCents) ? maxPriceCents : null,
                availability: view.availability,
                sort: view.sort,
            },
            hasActiveFilters: Boolean(
                view.q ||
                view.category ||
                view.price_min ||
                view.price_max ||
                view.availability ||
                view.sort !== "random"
            ),
        };
    }

    app.get("/", (req, res) => {
        const catalogue = readCatalogueFilters(req.query);

        render(res, "home", {
            title: "Boutique RecyTech",
            metaDescription: "Ordinateurs, écrans, vidéoprojecteurs et accessoires reconditionnés par RecyTech, avec Linux possible, garantie et prix accessibles.",
            structuredData: organizationStructuredData(req),
            products: listPublishedProducts(db, catalogue.productFilters),
            catalogueFilters: catalogue.view,
            catalogueCategories: listProductCategories(db, { publishedOnly: true }),
            hasCatalogueFilters: catalogue.hasActiveFilters,
            reviews: listApprovedSiteReviews(db),
            reviewSummary: getSiteReviewSummary(db),
        });
    });

    app.get(["/politique-confidentialite", "/conditions-generales-de-vente", "/remboursements-retours"], (req, res) => {
        const slug = req.path.replace(/^\//, "");
        const page = getLegalPages(res.locals.settings)[slug];

        render(res, "legal", {
            title: page.title,
            page,
        });
    });

    app.get("/products/:slug", (req, res) => {
        const product = getProductBySlug(db, req.params.slug);
        if (!product || !product.published) {
            return res.status(404).render("not-found", { title: "Produit introuvable" });
        }

        render(res, "product", {
            title: product.name,
            metaDescription: productMetaDescription(product),
            metaImageUrl: product.gallery_images?.[0] || product.image_url || "/static/images/recytech-logo.svg",
            ogType: "product",
            structuredData: productStructuredData(req, product),
            product,
        });
    });

    app.post("/reviews", (req, res) => {
        try {
            const input = readSiteReviewInput(req.body);
            createSiteReview(db, input);
            setFlash(req, "success", "Merci ! Nous vérifions les avis avant publication pour éviter le spam.");
        } catch (error) {
            setFlash(req, "error", error.message);
        }

        return saveSessionAndRedirect(req, res, "/#reviews");
    });

    app.post("/cart/add", (req, res) => {
        const productId = Number.parseInt(req.body.product_id, 10);
        const quantity = Number.parseInt(req.body.quantity || "1", 10) || 1;
        const product = getProductById(db, productId);

        if (!product || !product.published) {
            setFlash(req, "error", "Produit introuvable.");
            return saveSessionAndRedirect(req, res, "/");
        }

        const redirectTarget = getSafeRedirectTarget(req.body.redirect_to, `/products/${product.slug}`);

        if (product.inventory <= 0) {
            setFlash(req, "error", "Ce produit est en rupture de stock.");
            return saveSessionAndRedirect(req, res, redirectTarget);
        }

        let selectedOptions = [];

        try {
            selectedOptions = readSelectedProductOptions(product, req.body);
            ensureAvailableProductQuantity(product, selectedOptions, quantity);
        } catch (error) {
            setFlash(req, "error", error.message);
            return saveSessionAndRedirect(req, res, redirectTarget);
        }

        upsertCartItem(req, productId, quantity, selectedOptions);
        setFlash(req, "success", `${product.name} a été ajouté au panier.`, {
            actionHref: "/cart",
            actionLabel: "Voir le panier",
        });
        saveSessionAndRedirect(req, res, redirectTarget);
    });

    app.get("/cart", (req, res) => {
        render(res, "cart", {
            title: "Panier",
        });
    });

    app.post("/cart/update", (req, res) => {
        const itemKey = normalizeText(req.body.item_key);
        const productId = Number.parseInt(req.body.product_id, 10);
        const quantity = Number.parseInt(req.body.quantity || "1", 10) || 1;
        const product = getProductById(db, productId);
        const cartItem = getCartItems(req).find((item) => (item.itemKey || makeCartItemKey(item.productId, item.selectedOptions || [])) === itemKey);

        if (!product || product.inventory <= 0) {
            if (itemKey) {
                removeCartItem(req, itemKey);
            }
            setFlash(req, "error", "Ce produit n'est plus disponible.");
            return saveSessionAndRedirect(req, res, "/cart");
        }

        try {
            ensureAvailableProductQuantity(product, cartItem?.selectedOptions || [], quantity);
        } catch (error) {
            setFlash(req, "error", error.message);
            return saveSessionAndRedirect(req, res, "/cart");
        }

        upsertCartItem(req, productId, quantity, cartItem?.selectedOptions || []);
        setFlash(req, "success", "Le panier a été mis à jour.");
        saveSessionAndRedirect(req, res, "/cart");
    });

    app.post("/cart/remove", (req, res) => {
        const itemKey = normalizeText(req.body.item_key);
        if (itemKey) {
            removeCartItem(req, itemKey);
        }
        setFlash(req, "success", "Le produit a été retiré du panier.");
        saveSessionAndRedirect(req, res, "/cart");
    });
}

module.exports = { registerStorefrontRoutes };
