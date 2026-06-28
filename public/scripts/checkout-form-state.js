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

    function persist() {
        const payload = buildCheckoutDraftPayload(checkoutForm);

        if (!payload) {
            return;
        }

        fetch(endpoint, {
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

    function schedule() {
        if (!checkoutForm) {
            return;
        }

        window.clearTimeout(timer);
        timer = window.setTimeout(persist, delayMs);
    }

    return {
        persist,
        schedule,
    };
}
