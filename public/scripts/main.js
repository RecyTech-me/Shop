const csrfTokenMeta = document.querySelector('meta[name="csrf-token"]');
const csrfToken = csrfTokenMeta?.content || "";
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

if (csrfToken) {
    document.querySelectorAll('form[method="post"]').forEach((form) => {
        let hiddenField = form.querySelector('input[name="_csrf"]');

        if (!hiddenField) {
            hiddenField = document.createElement("input");
            hiddenField.type = "hidden";
            hiddenField.name = "_csrf";
            form.append(hiddenField);
        }

        hiddenField.value = csrfToken;
    });
}

document.querySelectorAll(".flash").forEach((flash) => {
    window.setTimeout(() => {
        flash.classList.add("flash-hidden");
        window.setTimeout(() => {
            flash.parentElement?.classList.add("flash-shell-hidden");
        }, 220);
    }, 5000);
});

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

const deliveryInputs = document.querySelectorAll('input[name="delivery_method"]');
const paymentMethodInputs = document.querySelectorAll('input[name="payment_method"]');
const billingSameInput = document.querySelector('input[name="billing_same_as_shipping"]');
const shippingSection = document.querySelector('[data-checkout-section="shipping"]');
const pickupSection = document.querySelector('[data-checkout-section="pickup"]');
const billingToggleSection = document.querySelector('[data-checkout-section="billing-toggle"]');
const billingSection = document.querySelector('[data-checkout-section="billing"]');
const cardPaymentSection = document.querySelector('[data-checkout-section="card-payment"]');
const cashPaymentOption = document.querySelector('[data-checkout-section="cash-payment-option"]');
const shippingPrice = document.getElementById("checkout-shipping-price");
const promoRow = document.getElementById("checkout-promo-row");
const promoLabel = document.getElementById("checkout-promo-label");
const promoAmount = document.getElementById("checkout-promo-amount");
const paymentDiscountRow = document.getElementById("checkout-payment-discount-row");
const paymentDiscountLabel = document.getElementById("checkout-payment-discount-label");
const paymentDiscountAmount = document.getElementById("checkout-payment-discount-amount");
const orderTotal = document.getElementById("checkout-order-total");
const optionalPhoneFields = document.querySelectorAll('input[name="shipping_phone"], input[name="billing_phone"]');
const checkoutForm = document.querySelector(".checkout-form");
const stripeMount = document.getElementById("stripe-payment-element");
const stripeMessage = document.getElementById("stripe-payment-message");
let checkoutDraftTimer = null;
let stripeClient = null;
let stripeElements = null;
let stripePaymentElement = null;
let stripeIntentId = "";
let stripeClientSecret = "";
let stripeLoadingPromise = null;
const discountedPaymentMethods = new Set(["bitcoin", "cash"]);

function formatChf(cents) {
    return new Intl.NumberFormat("fr-CH", {
        style: "currency",
        currency: "CHF",
        maximumFractionDigits: 2,
    }).format((cents || 0) / 100);
}

function toggleSection(section, shouldShow) {
    if (!section) {
        return;
    }

    section.hidden = !shouldShow;

    section.querySelectorAll("input, select, textarea").forEach((field) => {
        if (field.dataset.alwaysEnabled === "true") {
            return;
        }

        if (!field.dataset.originalRequired) {
            field.dataset.originalRequired = field.required ? "true" : "false";
        }

        field.disabled = !shouldShow;
        field.required = shouldShow && field.dataset.originalRequired === "true";
    });
}

function showStripeMessage(message, tone = "error") {
    if (!stripeMessage) {
        return;
    }

    if (!message) {
        stripeMessage.hidden = true;
        stripeMessage.textContent = "";
        stripeMessage.dataset.tone = "";
        return;
    }

    stripeMessage.hidden = false;
    stripeMessage.textContent = message;
    stripeMessage.dataset.tone = tone;
}

function getSelectedPaymentMethod() {
    return document.querySelector('input[name="payment_method"]:checked')?.value || "card";
}

function getStripeKey() {
    return checkoutForm?.dataset.stripePublishableKey || "";
}

function selectFirstEnabledPaymentMethod(candidates) {
    for (const value of candidates) {
        const input = document.querySelector(`input[name="payment_method"][value="${value}"]`);
        if (input && !input.disabled) {
            input.checked = true;
            return value;
        }
    }

    return getSelectedPaymentMethod();
}

function ensureValidPaymentMethod(selectedDelivery) {
    const allowedMethods = selectedDelivery === "pickup"
        ? ["card", "transfer", "bitcoin", "cash"]
        : ["card", "transfer", "bitcoin"];
    const currentInput = document.querySelector('input[name="payment_method"]:checked');

    if (currentInput && !currentInput.disabled && allowedMethods.includes(currentInput.value)) {
        return currentInput.value;
    }

    return selectFirstEnabledPaymentMethod(allowedMethods);
}

function getPaymentDiscountLabel(paymentMethod) {
    if (paymentMethod === "bitcoin") {
        return "Réduction Bitcoin (-10%)";
    }

    if (paymentMethod === "cash") {
        return "Réduction retrait espèces (-10%)";
    }

    return "";
}

function syncCheckoutSections() {
    const selectedDelivery = document.querySelector('input[name="delivery_method"]:checked')?.value || "pickup";

    toggleSection(shippingSection, selectedDelivery === "ship");
    toggleSection(pickupSection, selectedDelivery === "pickup");
    toggleSection(cashPaymentOption, selectedDelivery === "pickup");

    if (billingSameInput) {
        const wasDisabled = billingSameInput.disabled;

        if (selectedDelivery === "pickup") {
            billingSameInput.checked = false;
        }

        if (selectedDelivery === "ship" && wasDisabled) {
            billingSameInput.checked = true;
        }

        toggleSection(billingToggleSection, selectedDelivery === "ship");
        billingSameInput.disabled = selectedDelivery !== "ship";
    }

    const shouldShowBilling = selectedDelivery === "pickup" || Boolean(billingSameInput && !billingSameInput.checked);
    toggleSection(billingSection, shouldShowBilling);
    const selectedPayment = ensureValidPaymentMethod(selectedDelivery);
    toggleSection(cardPaymentSection, selectedPayment === "card");

    if (shippingPrice && orderTotal) {
        const deliveryPrice = Number.parseInt(
            selectedDelivery === "ship" ? shippingPrice.dataset.priceShip : shippingPrice.dataset.pricePickup,
            10
        ) || 0;
        const subtotal = Number.parseInt(orderTotal.dataset.subtotal || "0", 10) || 0;
        const paymentDiscountRate = Number.parseFloat(orderTotal.dataset.paymentDiscountRate || "0") || 0;
        const promoDiscountCents = Number.parseInt(orderTotal.dataset.promoDiscount || "0", 10) || 0;
        const paymentDiscountBaseCents = Math.max(subtotal - promoDiscountCents, 0);
        const paymentDiscountCents = discountedPaymentMethods.has(selectedPayment)
            ? Math.round(paymentDiscountBaseCents * paymentDiscountRate)
            : 0;

        shippingPrice.textContent = formatChf(deliveryPrice);
        if (promoRow && promoLabel && promoAmount) {
            promoRow.hidden = promoDiscountCents <= 0;
            promoLabel.textContent = orderTotal.dataset.promoLabel || "Code promo";
            promoAmount.textContent = `-${formatChf(promoDiscountCents)}`;
        }
        if (paymentDiscountRow && paymentDiscountLabel && paymentDiscountAmount) {
            paymentDiscountRow.hidden = paymentDiscountCents <= 0;
            paymentDiscountLabel.textContent = getPaymentDiscountLabel(selectedPayment);
            paymentDiscountAmount.textContent = `-${formatChf(paymentDiscountCents)}`;
        }
        orderTotal.textContent = formatChf(subtotal + deliveryPrice - promoDiscountCents - paymentDiscountCents);
    }
}

function buildCheckoutDraftPayload() {
    if (!checkoutForm) {
        return null;
    }

    const payload = {};

    checkoutForm.querySelectorAll("input, select, textarea").forEach((field) => {
        if (!field.name) {
            return;
        }

        if (field.type === "radio") {
            if (field.checked) {
                payload[field.name] = field.value;
            }
            return;
        }

        if (field.type === "checkbox") {
            payload[field.name] = field.checked ? (field.value || "1") : "0";
            return;
        }

        payload[field.name] = field.value;
    });

    return payload;
}

function persistCheckoutDraft() {
    const payload = buildCheckoutDraftPayload();

    if (!payload) {
        return;
    }

    fetch("/checkout/session", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(payload),
        keepalive: true,
    }).catch(() => {
        // Draft persistence is best-effort and should not block checkout usage.
    });
}

function scheduleCheckoutDraftSave() {
    if (!checkoutForm) {
        return;
    }

    window.clearTimeout(checkoutDraftTimer);
    checkoutDraftTimer = window.setTimeout(persistCheckoutDraft, 250);
}

async function ensureStripeClient() {
    if (stripeClient || !checkoutForm || !getStripeKey()) {
        return stripeClient;
    }

    if (typeof window.Stripe !== "function") {
        throw new Error("Stripe n'a pas pu se charger.");
    }

    stripeClient = window.Stripe(getStripeKey(), { locale: "fr" });
    return stripeClient;
}

async function fetchStripeIntent() {
    const response = await fetch(checkoutForm.dataset.stripeIntentUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(buildCheckoutDraftPayload() || {}),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || "Impossible d'initialiser Stripe.");
    }

    return data;
}

async function mountStripePaymentElement(forceRefresh = false) {
    if (!checkoutForm || !cardPaymentSection || cardPaymentSection.hidden || !stripeMount) {
        return;
    }

    if (stripeLoadingPromise && !forceRefresh) {
        return stripeLoadingPromise;
    }

    stripeLoadingPromise = (async () => {
        showStripeMessage("");

        const client = await ensureStripeClient();
        if (!client) {
            return;
        }

        if (forceRefresh && stripePaymentElement) {
            stripePaymentElement.unmount();
            stripePaymentElement = null;
            stripeElements = null;
            stripeIntentId = "";
            stripeClientSecret = "";
        }

        const intent = await fetchStripeIntent();
        if (intent.clientSecret === stripeClientSecret && stripePaymentElement) {
            return;
        }

        stripeIntentId = intent.paymentIntentId;
        stripeClientSecret = intent.clientSecret;

        if (stripePaymentElement) {
            stripePaymentElement.unmount();
        }

        stripeMount.innerHTML = "";
        stripeElements = client.elements({
            clientSecret: stripeClientSecret,
            appearance: {
                theme: "stripe",
                variables: {
                    colorPrimary: "#244c38",
                    colorBackground: "#ffffff",
                    colorText: "#243227",
                    colorDanger: "#b42318",
                    fontFamily: "Inter, Segoe UI, sans-serif",
                    borderRadius: "12px",
                },
            },
        });
        stripePaymentElement = stripeElements.create("payment", {
            layout: "tabs",
            defaultValues: {
                billingDetails: {
                    email: document.querySelector('input[name="customer_email"]')?.value || "",
                    name: [
                        document.querySelector('input[name="customer_first_name"]')?.value || "",
                        document.querySelector('input[name="customer_last_name"]')?.value || "",
                    ].join(" ").trim(),
                },
            },
        });
        stripePaymentElement.mount("#stripe-payment-element");
    })().finally(() => {
        stripeLoadingPromise = null;
    });

    return stripeLoadingPromise;
}

function buildStripeBillingDetails() {
    const payload = buildCheckoutDraftPayload() || {};
    const usesShipping = payload.delivery_method === "ship" && payload.billing_same_as_shipping === "1";
    const name = [
        payload.customer_first_name || payload.billing_first_name || "",
        payload.customer_last_name || payload.billing_last_name || "",
    ].join(" ").trim();

    return {
        email: payload.customer_email || "",
        name,
        phone: usesShipping ? (payload.shipping_phone || "") : (payload.billing_phone || ""),
        address: {
            country: "CH",
            line1: usesShipping ? (payload.shipping_address1 || "") : (payload.billing_address1 || ""),
            postal_code: usesShipping ? (payload.shipping_postal_code || "") : (payload.billing_postal_code || ""),
            city: usesShipping ? (payload.shipping_city || "") : (payload.billing_city || ""),
            state: usesShipping ? (payload.shipping_region || "") : (payload.billing_region || ""),
        },
    };
}

async function prepareStripeOrder() {
    const payload = {
        ...(buildCheckoutDraftPayload() || {}),
        stripe_payment_intent_id: stripeIntentId,
    };

    const response = await fetch(checkoutForm.dataset.stripePrepareUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || "Impossible de préparer la commande Stripe.");
    }

    return data;
}

async function submitStripeCheckout(event) {
    event.preventDefault();

    if (!checkoutForm?.reportValidity()) {
        return;
    }

    const submitButton = checkoutForm.querySelector('button[type="submit"]');
    submitButton?.setAttribute("disabled", "disabled");
    showStripeMessage("");

    try {
        await mountStripePaymentElement();
        if (!stripeClient || !stripeElements || !stripeClientSecret || !stripeIntentId) {
            throw new Error("Le formulaire Stripe n'est pas prêt.");
        }

        const prepared = await prepareStripeOrder();
        const { error: submitError } = await stripeElements.submit();
        if (submitError) {
            throw submitError;
        }

        const result = await stripeClient.confirmPayment({
            elements: stripeElements,
            clientSecret: stripeClientSecret,
            confirmParams: {
                payment_method_data: {
                    billing_details: buildStripeBillingDetails(),
                },
            },
            redirect: "if_required",
        });

        if (result.error) {
            throw result.error;
        }

        window.location.assign(prepared.successUrl);
    } catch (error) {
        showStripeMessage(error.message || "Le paiement par carte a échoué.");
        submitButton?.removeAttribute("disabled");
    }
}

deliveryInputs.forEach((input) => {
    input.addEventListener("change", () => {
        syncCheckoutSections();
        if (getSelectedPaymentMethod() === "card") {
            mountStripePaymentElement(true).catch((error) => {
                showStripeMessage(error.message || "Impossible de mettre à jour Stripe.");
            });
        }
        scheduleCheckoutDraftSave();
    });
});

paymentMethodInputs.forEach((input) => {
    input.addEventListener("change", () => {
        syncCheckoutSections();
        if (input.checked && input.value === "card") {
            mountStripePaymentElement().catch((error) => {
                showStripeMessage(error.message || "Impossible de charger Stripe.");
            });
        } else {
            showStripeMessage("");
        }
        scheduleCheckoutDraftSave();
    });
});

if (billingSameInput) {
    billingSameInput.addEventListener("change", () => {
        syncCheckoutSections();
        scheduleCheckoutDraftSave();
    });
}

optionalPhoneFields.forEach((field) => {
    field.dataset.originalRequired = "false";
});

if (checkoutForm) {
    checkoutForm.addEventListener("input", scheduleCheckoutDraftSave);
    checkoutForm.addEventListener("change", scheduleCheckoutDraftSave);
    checkoutForm.addEventListener("submit", (event) => {
        if (event.submitter?.hasAttribute("data-skip-stripe-submit")) {
            return;
        }

        if (getSelectedPaymentMethod() === "card") {
            submitStripeCheckout(event);
        }
    });
}

syncCheckoutSections();

if (getSelectedPaymentMethod() === "card") {
    mountStripePaymentElement().catch((error) => {
        showStripeMessage(error.message || "Impossible de charger Stripe.");
    });
}

document.querySelectorAll("[data-product-gallery]").forEach((gallery) => {
    const track = gallery.querySelector("[data-product-gallery-track]");
    const slides = [...gallery.querySelectorAll("[data-gallery-slide]")];
    const thumbs = [...gallery.querySelectorAll("[data-gallery-image]")];
    const previousButton = gallery.querySelector("[data-gallery-prev]");
    const nextButton = gallery.querySelector("[data-gallery-next]");

    if (!track || !thumbs.length) {
        return;
    }

    const totalSlides = thumbs.length;
    let currentIndex = Math.max(thumbs.findIndex((thumb) => thumb.classList.contains("is-active")), 0);
    let visualIndex = totalSlides > 1 ? currentIndex + 1 : currentIndex;
    let isTransitioning = false;
    let transitionFallbackTimer = 0;

    function updateThumbs(index) {
        thumbs.forEach((thumb, thumbIndex) => {
            thumb.classList.toggle("is-active", thumbIndex === index);
        });
    }

    function updateSlides(index) {
        slides.forEach((slide) => {
            const logicalIndex = Number(slide.dataset.galleryLogicalIndex || 0);
            slide.setAttribute("aria-hidden", String(logicalIndex !== index));
        });
    }

    function applyTrackPosition(animate = true) {
        track.classList.toggle("is-no-transition", !animate);
        track.style.transform = `translateX(-${visualIndex * 100}%)`;
    }

    function finishTransition() {
        clearTimeout(transitionFallbackTimer);

        if (visualIndex === 0) {
            visualIndex = totalSlides;
            applyTrackPosition(false);
            track.getBoundingClientRect();
        } else if (visualIndex === totalSlides + 1) {
            visualIndex = 1;
            applyTrackPosition(false);
            track.getBoundingClientRect();
        }

        isTransitioning = false;
    }

    function syncGallery(index, direction = "next") {
        const safeIndex = ((index % totalSlides) + totalSlides) % totalSlides;
        const activeThumb = thumbs[safeIndex];

        if (!activeThumb || isTransitioning || safeIndex === currentIndex) {
            return;
        }

        isTransitioning = true;
        currentIndex = safeIndex;
        updateThumbs(currentIndex);
        updateSlides(currentIndex);

        if (direction === "next" && safeIndex === 0 && totalSlides > 1) {
            visualIndex = totalSlides + 1;
        } else if (direction === "prev" && safeIndex === totalSlides - 1 && totalSlides > 1) {
            visualIndex = 0;
        } else {
            visualIndex = safeIndex + (totalSlides > 1 ? 1 : 0);
        }

        requestAnimationFrame(() => {
            applyTrackPosition(true);
        });

        transitionFallbackTimer = setTimeout(finishTransition, 420);
    }

    track.addEventListener("transitionend", (event) => {
        if (event.target !== track || event.propertyName !== "transform" || !isTransitioning) {
            return;
        }

        finishTransition();
    });

    applyTrackPosition(false);
    requestAnimationFrame(() => {
        track.classList.remove("is-no-transition");
    });
    updateThumbs(currentIndex);
    updateSlides(currentIndex);

    thumbs.forEach((thumb, index) => {
        thumb.addEventListener("click", () => {
            const direction = index < currentIndex ? "prev" : "next";
            syncGallery(index, direction);
        });
    });

    previousButton?.addEventListener("click", () => {
        syncGallery(currentIndex - 1, "prev");
    });

    nextButton?.addEventListener("click", () => {
        syncGallery(currentIndex + 1, "next");
    });

    gallery.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            syncGallery(currentIndex - 1, "prev");
        }

        if (event.key === "ArrowRight") {
            event.preventDefault();
            syncGallery(currentIndex + 1, "next");
        }
    });
});

document.querySelectorAll("[data-product-configurator]").forEach((form) => {
    const selects = [...form.querySelectorAll("select[data-option-group]")];
    const message = form.querySelector("[data-product-configurator-message]");
    const productDetail = form.closest(".product-detail");
    const priceTarget = productDetail?.querySelector("[data-product-price]") || document.querySelector("[data-product-price]");
    const basePriceCents = Number.parseInt(form.dataset.basePriceCents || priceTarget?.dataset.basePriceCents || "0", 10) || 0;
    const startingPriceCents = Number.parseInt(form.dataset.startingPriceCents || priceTarget?.dataset.startingPriceCents || `${basePriceCents}`, 10) || basePriceCents;
    const currency = form.dataset.currency || priceTarget?.dataset.currency || "CHF";
    const hasConfigurationPricing = priceTarget?.dataset.hasConfigurationPricing === "true";

    if (!selects.length) {
        return;
    }

    let validConfigurations = [];

    try {
        validConfigurations = JSON.parse(form.dataset.validConfigurations || "[]");
    } catch {
        validConfigurations = [];
    }

    validConfigurations = Array.isArray(validConfigurations)
        ? validConfigurations
            .map((configuration) => {
                const selections = Array.isArray(configuration)
                    ? configuration
                    : Array.isArray(configuration?.selections)
                        ? configuration.selections
                        : [];
                const rawPriceCents = !Array.isArray(configuration) ? configuration?.price_cents : null;
                const priceCents = Number.parseInt(rawPriceCents, 10);

                return {
                    selections: selections
                        .map((selection) => ({
                            name: String(selection?.name || "").trim(),
                            value: String(selection?.value || "").trim(),
                        }))
                        .filter((selection) => selection.name && selection.value),
                    priceCents: Number.isInteger(priceCents) && priceCents >= 0 ? priceCents : null,
                };
            })
            .filter((configuration) => configuration.selections.length)
        : [];

    if (!validConfigurations.length) {
        return;
    }

    function formatProductPrice(cents) {
        return new Intl.NumberFormat("fr-CH", {
            style: "currency",
            currency,
            maximumFractionDigits: 2,
        }).format((cents || 0) / 100);
    }

    function currentSelections() {
        return new Map(
            selects
                .map((select) => [select.dataset.optionGroup || "", select.value])
                .filter(([name]) => name)
        );
    }

    function isConfigurationCompatible(configuration, targetGroupName, candidateValue, selections) {
        return configuration.selections.every((selection) => {
            if (selection.name === targetGroupName) {
                return selection.value === candidateValue;
            }

            const selectedValue = selections.get(selection.name);
            return !selectedValue || selectedValue === selection.value;
        });
    }

    function getCompleteConfiguration(selections) {
        if (selects.some((select) => !select.value)) {
            return null;
        }

        return validConfigurations.find((configuration) =>
            configuration.selections.length === selects.length &&
            configuration.selections.every((selection) =>
                selections.get(selection.name) === selection.value
            )
        ) || null;
    }

    function syncProductPrice(selections) {
        if (!priceTarget || !hasConfigurationPricing) {
            return;
        }

        const configuration = getCompleteConfiguration(selections);
        const priceCents = configuration ? (configuration.priceCents ?? basePriceCents) : startingPriceCents;
        priceTarget.textContent = configuration
            ? formatProductPrice(priceCents)
            : `À partir de ${formatProductPrice(priceCents)}`;
    }

    function syncConfigurator() {
        const selections = currentSelections();

        selects.forEach((select) => {
            const groupName = select.dataset.optionGroup || "";
            const currentValue = select.value;

            [...select.options].forEach((option) => {
                if (!option.value) {
                    option.disabled = false;
                    return;
                }

                option.disabled = !validConfigurations.some((configuration) =>
                    isConfigurationCompatible(configuration, groupName, option.value, selections)
                );
            });

            if (currentValue && select.selectedOptions[0]?.disabled) {
                select.value = "";
            }
        });

        const finalSelections = currentSelections();
        const hasPartialSelection = selects.some((select) => select.value);
        const hasAnyCompatibleConfiguration = validConfigurations.some((configuration) =>
            configuration.selections.every((selection) => {
                const selectedValue = finalSelections.get(selection.name);
                return !selectedValue || selectedValue === selection.value;
            })
        );

        if (message) {
            if (hasPartialSelection && !hasAnyCompatibleConfiguration) {
                message.hidden = false;
                message.textContent = "Cette combinaison n'est pas disponible.";
            } else {
                message.hidden = true;
                message.textContent = "";
            }
        }

        syncProductPrice(finalSelections);
    }

    selects.forEach((select) => {
        select.addEventListener("change", syncConfigurator);
    });

    syncConfigurator();
});

const confirmModal = document.querySelector("[data-confirm-modal]");
const confirmModalTitle = confirmModal?.querySelector("[data-confirm-title]");
const confirmModalMessage = confirmModal?.querySelector("[data-confirm-message]");
const confirmModalSubmit = confirmModal?.querySelector("[data-confirm-submit]");
const confirmModalCancel = confirmModal?.querySelector("[data-confirm-cancel]");
let pendingConfirmForm = null;

function closeConfirmModal() {
    if (!confirmModal) {
        return;
    }

    confirmModal.hidden = true;
    document.body.classList.remove("modal-open");
    pendingConfirmForm = null;
}

if (confirmModal && confirmModalTitle && confirmModalMessage && confirmModalSubmit) {
    document.querySelectorAll("[data-confirm-form]").forEach((form) => {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            pendingConfirmForm = form;
            confirmModalTitle.textContent = form.dataset.confirmTitle || "Confirmer l'action";
            confirmModalMessage.textContent = form.dataset.confirmMessage || "Cette action est irréversible.";
            confirmModalSubmit.textContent = form.dataset.confirmSubmit || "Confirmer";
            confirmModal.hidden = false;
            document.body.classList.add("modal-open");
        });
    });

    confirmModal.addEventListener("click", (event) => {
        if (event.target.hasAttribute("data-confirm-close")) {
            closeConfirmModal();
        }
    });

    confirmModalCancel?.addEventListener("click", closeConfirmModal);

    confirmModalSubmit.addEventListener("click", () => {
        if (!pendingConfirmForm) {
            closeConfirmModal();
            return;
        }

        const form = pendingConfirmForm;
        closeConfirmModal();
        form.submit();
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !confirmModal.hidden) {
            closeConfirmModal();
        }
    });
}
