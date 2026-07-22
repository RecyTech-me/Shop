export function initCatalogue() {
    let catalogueAbortController = null;

    function getCatalogueSection(root = document) {
        if (root instanceof HTMLElement && root.id === "catalogue") {
            return root;
        }

        return root.querySelector?.("#catalogue") || null;
    }

    function escapeSelectorValue(value) {
        if (window.CSS?.escape) {
            return window.CSS.escape(value);
        }

        return String(value || "").replace(/["\\]/g, "\\$&");
    }

    function buildCatalogueUrl(form) {
        const url = new URL(form.getAttribute("action") || window.location.href, window.location.href);
        const params = new URLSearchParams();

        url.hash = "";
        new FormData(form).forEach((value, key) => {
            const text = String(value || "").trim();
            if (text) {
                params.append(key, text);
            }
        });
        url.search = params.toString();

        return url;
    }

    function setCatalogueRefreshing(section, isRefreshing) {
        section.classList.toggle("catalogue-refreshing", isRefreshing);
        section.setAttribute("aria-busy", isRefreshing ? "true" : "false");
    }

    function restoreCatalogueFocus(section, fieldName) {
        if (!fieldName) {
            return;
        }

        const field = section.querySelector(`[name="${escapeSelectorValue(fieldName)}"]`);
        if (field instanceof HTMLElement) {
            field.focus({ preventScroll: true });
        }
    }

    async function refreshCatalogue(url, options = {}) {
        const currentSection = getCatalogueSection();
        if (!currentSection) {
            window.location.assign(url.href);
            return;
        }

        catalogueAbortController?.abort();
        const controller = new AbortController();
        catalogueAbortController = controller;

        const shouldReopenFilters = Boolean(currentSection.querySelector(".catalogue-filter-more")?.open);
        setCatalogueRefreshing(currentSection, true);

        try {
            const response = await fetch(url, {
                headers: {
                    "X-Requested-With": "fetch",
                },
                credentials: "same-origin",
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`Catalogue refresh failed with status ${response.status}`);
            }

            const html = await response.text();
            const nextDocument = new DOMParser().parseFromString(html, "text/html");
            const nextSection = getCatalogueSection(nextDocument);
            if (!nextSection) {
                throw new Error("Catalogue section missing from response.");
            }

            if (shouldReopenFilters) {
                nextSection.querySelector(".catalogue-filter-more")?.setAttribute("open", "");
            }

            const scrollX = window.scrollX;
            const scrollY = window.scrollY;
            currentSection.replaceWith(nextSection);
            window.scrollTo(scrollX, scrollY);
            initCatalogueFilters(nextSection);

            if (!options.skipHistory) {
                window.history.pushState({ catalogue: true }, "", `${url.pathname}${url.search}`);
            }

            restoreCatalogueFocus(nextSection, options.focusName);
        } catch (error) {
            if (error.name === "AbortError") {
                return;
            }

            window.location.assign(`${url.pathname}${url.search}#catalogue`);
        } finally {
            if (catalogueAbortController === controller) {
                catalogueAbortController = null;
                if (currentSection.isConnected) {
                    setCatalogueRefreshing(currentSection, false);
                }
            }
        }
    }

    function initCatalogueFilters(root = document) {
        const section = getCatalogueSection(root);
        const form = section?.querySelector(".catalogue-filters");
        if (!section || !form || form.dataset.catalogueEnhanced === "true") {
            return;
        }

        form.dataset.catalogueEnhanced = "true";
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            refreshCatalogue(buildCatalogueUrl(form), {
                focusName: document.activeElement?.name || "",
            });
        });

        form.querySelectorAll("[data-catalogue-auto-submit]").forEach((field) => {
            field.addEventListener("change", () => {
                refreshCatalogue(buildCatalogueUrl(form), {
                    focusName: field.name,
                });
            });
        });

        form.querySelectorAll('a[href="/#catalogue"]').forEach((link) => {
            link.addEventListener("click", (event) => {
                event.preventDefault();
                const url = new URL(link.getAttribute("href") || "/", window.location.href);
                url.hash = "";
                refreshCatalogue(url);
            });
        });
    }

    initCatalogueFilters();

    if (getCatalogueSection()) {
        window.addEventListener("popstate", () => {
            const url = new URL(window.location.href);
            url.hash = "";
            refreshCatalogue(url, { skipHistory: true });
        });
    }
}
