const DEFAULT_META_IMAGE = "/static/images/recytech-logo.svg";

function normalizeText(value) {
    return String(value || "").trim();
}

function buildPageTitle(title, settings = {}) {
    const storeName = normalizeText(settings.store_name) || "RecyTech Shop";
    const titleText = normalizeText(title) || storeName;

    return titleText === storeName || titleText.endsWith(`| ${storeName}`)
        ? titleText
        : `${titleText} | ${storeName}`;
}

function normalizeStructuredDataItems(value) {
    if (!value) {
        return [];
    }

    return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function buildSeoMetadata({
    title,
    settings = {},
    metaDescription,
    canonicalUrl,
    metaImageUrl,
    ogType,
    robots,
    structuredData,
    absoluteUrl,
} = {}) {
    const resolveUrl = typeof absoluteUrl === "function" ? absoluteUrl : (value) => value;
    const rawImageUrl = normalizeText(metaImageUrl) || DEFAULT_META_IMAGE;

    return {
        title: buildPageTitle(title, settings),
        description: normalizeText(metaDescription) || normalizeText(settings.tagline),
        canonicalUrl: normalizeText(canonicalUrl),
        imageUrl: resolveUrl(rawImageUrl),
        ogType: normalizeText(ogType) || "website",
        robots: normalizeText(robots) || "index,follow",
        siteName: normalizeText(settings.store_name) || "RecyTech Shop",
        structuredDataItems: normalizeStructuredDataItems(structuredData),
    };
}

module.exports = {
    buildSeoMetadata,
};
