const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSeoMetadata } = require("../lib/seo-metadata");

const settings = {
    store_name: "RecyTech",
    tagline: "Materiel reconditionne avec soin",
};

test("SEO metadata fills defaults from settings and absolute asset URLs", () => {
    const seo = buildSeoMetadata({
        title: "Boutique",
        settings,
        canonicalUrl: "https://shop.recytech.me/",
        absoluteUrl: (value) => `https://shop.recytech.me${value}`,
    });

    assert.equal(seo.title, "Boutique | RecyTech");
    assert.equal(seo.description, settings.tagline);
    assert.equal(seo.canonicalUrl, "https://shop.recytech.me/");
    assert.equal(seo.imageUrl, "https://shop.recytech.me/static/images/recytech-logo.svg");
    assert.equal(seo.ogType, "website");
    assert.equal(seo.siteName, "RecyTech");
    assert.deepEqual(seo.structuredDataItems, []);
});

test("SEO metadata keeps explicit product values and normalizes structured data", () => {
    const productData = { "@type": "Product", name: "ThinkPad" };
    const organizationData = { "@type": "Organization", name: "RecyTech" };

    const seo = buildSeoMetadata({
        title: "ThinkPad",
        settings,
        metaDescription: "ThinkPad reconditionne",
        metaImageUrl: "/static/uploads/thinkpad.webp",
        ogType: "product",
        structuredData: [productData, null, organizationData],
        absoluteUrl: (value) => `https://shop.recytech.me${value}`,
    });

    assert.equal(seo.title, "ThinkPad | RecyTech");
    assert.equal(seo.description, "ThinkPad reconditionne");
    assert.equal(seo.imageUrl, "https://shop.recytech.me/static/uploads/thinkpad.webp");
    assert.equal(seo.ogType, "product");
    assert.deepEqual(seo.structuredDataItems, [productData, organizationData]);
});

test("SEO metadata does not append the store name twice", () => {
    const seo = buildSeoMetadata({
        title: "Panier | RecyTech",
        settings,
    });

    assert.equal(seo.title, "Panier | RecyTech");
});
