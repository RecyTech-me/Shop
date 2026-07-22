function truncateText(value, maxLength) {
    const text = String(value || "").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function createPublicProductPresenters(options) {
    const {
        baseUrl,
        absoluteUrl,
        formatProductPrice,
    } = options;

    function setPublicApiHeaders(res) {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.set("Access-Control-Allow-Headers", "Content-Type");
        res.set("Cache-Control", "public, max-age=120");
    }

    function productCategoryList(product) {
        const categories = Array.isArray(product?.categories)
            ? product.categories.filter(Boolean)
            : [];

        return categories.length || !product?.category
            ? categories
            : [product.category];
    }

    function serializePublicProduct(req, product) {
        const images = (product.gallery_images || [])
            .map((src) => absoluteUrl(req, src))
            .filter(Boolean)
            .map((src, index) => ({
                id: `${product.id}-${index}`,
                src,
                alt: product.name,
                position: index,
            }));
        const displayPriceCents = product.starting_price_cents ?? product.price_cents;
        const categories = productCategoryList(product);

        return {
            id: product.id,
            slug: product.slug,
            type: product.is_pack ? "pack" : "product",
            name: product.name,
            short_description: product.short_description || "",
            description: product.description || "",
            price: ((displayPriceCents || 0) / 100).toFixed(2),
            regular_price: ((displayPriceCents || 0) / 100).toFixed(2),
            price_html: product.has_configuration_pricing ? formatProductPrice(product) : "",
            price_range: product.has_configuration_pricing
                ? {
                    min_price: ((product.starting_price_cents || 0) / 100).toFixed(2),
                    max_price: ((product.maximum_price_cents || 0) / 100).toFixed(2),
                }
                : null,
            currency: product.currency || "CHF",
            categories: categories.map((category) => ({
                id: category,
                name: category,
                slug: category.toLowerCase().replace(/\s+/g, "-"),
            })),
            bundle_items: product.is_pack
                ? (product.bundle_items || []).map((item) => ({
                    product_id: item.product_id,
                    slug: item.slug,
                    name: item.name,
                    quantity: item.quantity,
                    selected_options: item.selected_options || [],
                }))
                : [],
            featured: Boolean(product.featured),
            stock_quantity: Math.max(0, Number(product.inventory || 0)),
            stock_status: product.inventory > 0 ? "instock" : "outofstock",
            status: product.published ? "publish" : "draft",
            permalink: `${baseUrl(req).replace(/\/$/, "")}/products/${product.slug}`,
            images,
        };
    }

    function productMetaDescription(product) {
        return truncateText(product.short_description || product.description || "", 155) || "Matériel informatique reconditionné par RecyTech.";
    }

    function productStructuredData(req, product) {
        const images = (product.gallery_images || [])
            .map((src) => absoluteUrl(req, src))
            .filter(Boolean);
        const displayPriceCents = product.starting_price_cents ?? product.price_cents;

        return {
            "@context": "https://schema.org",
            "@type": "Product",
            name: product.name,
            description: productMetaDescription(product),
            image: images,
            url: `${baseUrl(req).replace(/\/$/, "")}/products/${product.slug}`,
            brand: {
                "@type": "Brand",
                name: "RecyTech",
            },
            category: productCategoryList(product).join(", "),
            offers: {
                "@type": "Offer",
                priceCurrency: product.currency || "CHF",
                price: ((displayPriceCents || 0) / 100).toFixed(2),
                availability: product.inventory > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
                itemCondition: "https://schema.org/RefurbishedCondition",
                url: `${baseUrl(req).replace(/\/$/, "")}/products/${product.slug}`,
                seller: {
                    "@type": "Organization",
                    name: "RecyTech",
                },
            },
        };
    }

    function organizationStructuredData(req) {
        const origin = baseUrl(req).replace(/\/$/, "");

        return {
            "@context": "https://schema.org",
            "@type": "Organization",
            name: "RecyTech",
            url: origin || "https://shop.recytech.me",
            logo: absoluteUrl(req, "/static/images/recytech-logo.svg"),
            sameAs: [
                "https://recytech.me",
                "https://www.instagram.com/recytech.me",
                "https://github.com/RecyTech-me",
            ],
        };
    }

    return {
        setPublicApiHeaders,
        productCategoryList,
        serializePublicProduct,
        productMetaDescription,
        productStructuredData,
        organizationStructuredData,
    };
}

module.exports = { createPublicProductPresenters };
