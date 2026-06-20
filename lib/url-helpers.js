function createUrlHelpers(env) {
    function normalizeOrigin(value) {
        return String(value || "").trim().replace(/\/$/, "");
    }

    function readUrlHost(value) {
        try {
            return new URL(value).hostname.toLowerCase();
        } catch {
            return "";
        }
    }

    function isLocalHost(host) {
        return ["localhost", "127.0.0.1", "::1"].includes(String(host || "").toLowerCase());
    }

    function isLegacyShopHost(host) {
        return ["v2.shop.recytech.me"].includes(String(host || "").toLowerCase());
    }

    function requestOrigin(req) {
        const host = String(req.get("host") || "").trim();
        if (!host) {
            return "";
        }

        return `${req.protocol}://${host}`;
    }

    function baseUrl(req) {
        const configuredOrigin = normalizeOrigin(env.SHOP_PUBLIC_URL || env.BASE_URL);
        const currentRequestOrigin = normalizeOrigin(requestOrigin(req));
        const configuredHost = readUrlHost(configuredOrigin);
        const requestHost = readUrlHost(currentRequestOrigin);

        if (
            configuredOrigin &&
            currentRequestOrigin &&
            requestHost &&
            configuredHost !== requestHost &&
            !isLocalHost(requestHost) &&
            (isLocalHost(configuredHost) || isLegacyShopHost(configuredHost))
        ) {
            return currentRequestOrigin;
        }

        return configuredOrigin || currentRequestOrigin;
    }

    function getOrderDocumentConfig(req) {
        const publicBaseUrl = baseUrl(req).replace(/\/$/, "");

        return {
            termsUrl: String(env.TERMS_URL || "").trim() || (publicBaseUrl ? `${publicBaseUrl}/conditions-generales-de-vente` : ""),
            websiteUrl: String(env.PUBLIC_WEBSITE_URL || "").trim() || publicBaseUrl,
        };
    }

    function isSameSiteAssetUrl(value) {
        try {
            const url = new URL(value);
            return (
                ["shop.recytech.me", "v2.shop.recytech.me", "localhost", "127.0.0.1"].includes(url.hostname.toLowerCase()) &&
                url.pathname.startsWith("/static/")
            );
        } catch {
            return false;
        }
    }

    function absoluteUrl(req, value) {
        const input = String(value || "").trim();
        if (!input) {
            return "";
        }

        const origin = normalizeOrigin(baseUrl(req));

        if (/^https?:\/\//i.test(input)) {
            if (!isSameSiteAssetUrl(input)) {
                return input;
            }

            const url = new URL(input);
            return `${origin}${url.pathname}${url.search}`;
        }

        return `${origin}${input.startsWith("/") ? "" : "/"}${input}`;
    }

    return {
        baseUrl,
        getOrderDocumentConfig,
        absoluteUrl,
    };
}

module.exports = { createUrlHelpers };
