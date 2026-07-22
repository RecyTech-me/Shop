const { getLegalPages } = require("../lib/legal-pages");
const logger = require("../lib/logger");
const { getPublicErrorResponse } = require("../lib/http/public-errors");

const REVIEW_SUBMISSION_WINDOW_MS = 60 * 1000;

function registerStorefrontRoutes(deps) {
    const {
        app,
        db,
        http,
        rateLimiters = {},
        text,
        money,
        forms,
        publicProducts,
        cart,
        products,
        reviews,
    } = deps;
    const { render, setFlash, saveSessionAndRedirect, getSafeRedirectTarget } = http;
    const {
        getReviewSubmissionRateLimitState = () => ({ blockedUntil: 0 }),
        registerReviewSubmissionAttempt = () => {},
    } = rateLimiters;
    const { normalizeText, parseInteger } = text;
    const { parseMoneyToCents } = money;
    const { readSiteReviewInput, readSelectedProductOptions } = forms;
    const {
        ensureAvailableProductQuantity,
        upsertCartItem,
        getCartItems,
        makeCartItemKey,
        removeCartItem,
    } = cart;
    const {
        productMetaDescription,
        productStructuredData,
        organizationStructuredData,
    } = publicProducts;
    const {
        listPublishedProducts,
        listProductCategories,
        getProductBySlug,
        getProductById,
    } = products;
    const {
        listApprovedSiteReviews,
        getSiteReviewSummary,
        createSiteReview,
    } = reviews;

    function readPositiveInteger(value, label) {
        const parsed = parseInteger(value, Number.NaN);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
            throw new Error(`${label} invalide.`);
        }

        return parsed;
    }

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
        const rateLimitState = getReviewSubmissionRateLimitState(req);
        if (rateLimitState.blockedUntil > Date.now()) {
            setFlash(req, "error", "Veuillez patienter avant d'envoyer un nouvel avis.");
            return saveSessionAndRedirect(req, res, "/#reviews");
        }

        const lastSubmissionAt = Number.parseInt(req.session.lastReviewSubmissionAt || "0", 10) || 0;
        if (lastSubmissionAt && Date.now() - lastSubmissionAt < REVIEW_SUBMISSION_WINDOW_MS) {
            setFlash(req, "error", "Veuillez patienter avant d'envoyer un nouvel avis.");
            return saveSessionAndRedirect(req, res, "/#reviews");
        }

        try {
            const input = readSiteReviewInput(req.body);
            createSiteReview(db, input);
            req.session.lastReviewSubmissionAt = Date.now();
            registerReviewSubmissionAttempt(req);
            setFlash(req, "success", "Merci ! Nous vérifions les avis avant publication pour éviter le spam.");
        } catch (error) {
            const publicError = getPublicErrorResponse(
                error,
                "Impossible d'enregistrer votre avis. Veuillez réessayer."
            );
            if (publicError.internal) {
                logger.error("reviews.submission_failed", {
                    requestId: req.requestId,
                    error: error.message,
                });
            }
            setFlash(req, "error", publicError.message);
        }

        return saveSessionAndRedirect(req, res, "/#reviews");
    });

    app.post("/cart/add", (req, res) => {
        const productId = parseInteger(req.body.product_id, Number.NaN);
        const product = Number.isSafeInteger(productId) && productId > 0
            ? getProductById(db, productId)
            : null;

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
            const quantity = readPositiveInteger(req.body.quantity || "1", "Quantité");
            selectedOptions = readSelectedProductOptions(product, req.body);
            ensureAvailableProductQuantity(product, selectedOptions, quantity);
            upsertCartItem(req, productId, quantity, selectedOptions);
        } catch (error) {
            setFlash(req, "error", error.message);
            return saveSessionAndRedirect(req, res, redirectTarget);
        }

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
        const productId = parseInteger(req.body.product_id, Number.NaN);
        const product = Number.isSafeInteger(productId) && productId > 0
            ? getProductById(db, productId)
            : null;
        const cartItem = getCartItems(req).find((item) => (item.itemKey || makeCartItemKey(item.productId, item.selectedOptions || [])) === itemKey);

        if (!cartItem || Number(cartItem.productId) !== productId) {
            setFlash(req, "error", "Cet article ne correspond plus à votre panier.");
            return saveSessionAndRedirect(req, res, "/cart");
        }

        if (!product || !product.published || product.inventory <= 0) {
            if (itemKey) {
                removeCartItem(req, itemKey);
            }
            setFlash(req, "error", "Ce produit n'est plus disponible.");
            return saveSessionAndRedirect(req, res, "/cart");
        }

        try {
            const quantity = readPositiveInteger(req.body.quantity || "1", "Quantité");
            ensureAvailableProductQuantity(product, cartItem?.selectedOptions || [], quantity);
            upsertCartItem(req, productId, quantity, cartItem?.selectedOptions || []);
        } catch (error) {
            setFlash(req, "error", error.message);
            return saveSessionAndRedirect(req, res, "/cart");
        }

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
