export function formatChf(cents) {
    return new Intl.NumberFormat("fr-CH", {
        style: "currency",
        currency: "CHF",
        maximumFractionDigits: 2,
    }).format((cents || 0) / 100);
}

export function toggleSection(section, shouldShow) {
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

export function buildCheckoutDraftPayload(checkoutForm) {
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

export function createCheckoutDraftSaver({
    checkoutForm,
    csrfToken,
    endpoint = "/checkout/session",
    delayMs = 250,
}) {
    let timer = null;
    let inFlightRequest = null;
    let suspended = false;

    function persist() {
        const payload = buildCheckoutDraftPayload(checkoutForm);

        if (!payload) {
            return Promise.resolve();
        }

        const previousRequest = inFlightRequest || Promise.resolve();
        const request = previousRequest.then(() => fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
            },
            body: JSON.stringify(payload),
            keepalive: true,
        })).catch(() => {
            // Draft persistence is best-effort and should not block checkout usage.
        });
        inFlightRequest = request;
        request.finally(() => {
            if (inFlightRequest === request) {
                inFlightRequest = null;
            }
        });
        return request;
    }

    function schedule() {
        if (!checkoutForm || suspended) {
            return;
        }

        window.clearTimeout(timer);
        timer = window.setTimeout(persist, delayMs);
    }

    function flush() {
        suspended = true;
        window.clearTimeout(timer);
        timer = null;
        return inFlightRequest;
    }

    function resume() {
        suspended = false;
    }

    return {
        flush,
        persist,
        resume,
        schedule,
    };
}
