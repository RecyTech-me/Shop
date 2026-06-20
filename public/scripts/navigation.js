export function initNavigation() {
    const siteHeader = document.querySelector("[data-site-header]");
    const siteNav = document.querySelector("[data-site-nav]");
    const siteMenuToggle = document.querySelector("[data-site-menu-toggle]");
    const adminBar = document.querySelector("[data-admin-bar]");
    const adminNav = document.querySelector("[data-admin-nav]");
    const adminMenuToggle = document.querySelector("[data-admin-menu-toggle]");
    const mobileMenuBreakpoint = window.matchMedia("(max-width: 820px)");

    function syncExpandableMenuAccessibility(container, panel, toggle, openClassName) {
        if (!panel || !toggle) {
            return;
        }

        const isMenuOpen = Boolean(container?.classList.contains(openClassName));
        panel.setAttribute("aria-hidden", mobileMenuBreakpoint.matches && !isMenuOpen ? "true" : "false");
        toggle.setAttribute("aria-expanded", isMenuOpen ? "true" : "false");
    }

    function setExpandableMenuOpen(container, panel, toggle, shouldOpen, openClassName, labels) {
        if (!container || !toggle) {
            return;
        }

        container.classList.toggle(openClassName, shouldOpen);
        toggle.setAttribute("aria-label", shouldOpen ? labels.close : labels.open);
        syncExpandableMenuAccessibility(container, panel, toggle, openClassName);
    }

    function registerExpandableMenu({
        container,
        panel,
        toggle,
        openClassName,
        labels,
    }) {
        if (!container || !panel || !toggle) {
            return;
        }

        const setOpen = (shouldOpen) => {
            setExpandableMenuOpen(container, panel, toggle, shouldOpen, openClassName, labels);
        };

        toggle.addEventListener("click", () => {
            const shouldOpen = !container.classList.contains(openClassName);
            setOpen(shouldOpen);
        });

        panel.querySelectorAll("a").forEach((link) => {
            link.addEventListener("click", () => {
                if (mobileMenuBreakpoint.matches) {
                    setOpen(false);
                }
            });
        });

        document.addEventListener("click", (event) => {
            if (!mobileMenuBreakpoint.matches || !container.classList.contains(openClassName)) {
                return;
            }

            if (container.contains(event.target)) {
                return;
            }

            setOpen(false);
        });

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && container.classList.contains(openClassName)) {
                setOpen(false);
            }
        });

        const handleMenuBreakpointChange = (event) => {
            if (!event.matches) {
                setOpen(false);
                return;
            }

            syncExpandableMenuAccessibility(container, panel, toggle, openClassName);
        };

        if (typeof mobileMenuBreakpoint.addEventListener === "function") {
            mobileMenuBreakpoint.addEventListener("change", handleMenuBreakpointChange);
        } else if (typeof mobileMenuBreakpoint.addListener === "function") {
            mobileMenuBreakpoint.addListener(handleMenuBreakpointChange);
        }

        syncExpandableMenuAccessibility(container, panel, toggle, openClassName);
    }

    registerExpandableMenu({
        container: siteHeader,
        panel: siteNav,
        toggle: siteMenuToggle,
        openClassName: "menu-open",
        labels: {
            open: "Ouvrir le menu",
            close: "Fermer le menu",
        },
    });

    registerExpandableMenu({
        container: adminBar,
        panel: adminNav,
        toggle: adminMenuToggle,
        openClassName: "admin-menu-open",
        labels: {
            open: "Ouvrir le menu admin",
            close: "Fermer le menu admin",
        },
    });
}
