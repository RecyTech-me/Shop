function formatMoney(cents, currency = "CHF") {
    return new Intl.NumberFormat("fr-CH", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
    }).format((cents || 0) / 100);
}

function formatProductPrice(product) {
    if (product?.has_configuration_pricing) {
        return `À partir de ${formatMoney(product.starting_price_cents, product.currency)}`;
    }

    return formatMoney(product?.price_cents || 0, product?.currency || "CHF");
}

const SHIPPING_OPTIONS = {
    ship: {
        key: "ship",
        label: "La Poste",
        priceCents: 1150,
    },
    pickup: {
        key: "pickup",
        label: "Retrait au point de retrait",
        priceCents: 0,
    },
};

const PAYMENT_DISCOUNT_RATE = 0.1;

const ORDER_STATUS_OPTIONS = [
    { value: "pending", label: "En attente" },
    { value: "awaiting_transfer", label: "En attente du virement" },
    { value: "paid", label: "Payée" },
    { value: "processing", label: "En préparation" },
    { value: "ready_for_pickup", label: "Prête au retrait" },
    { value: "shipped", label: "Expédiée" },
    { value: "completed", label: "Terminée" },
    { value: "cancelled", label: "Annulée" },
    { value: "failed", label: "Échouée" },
    { value: "refunded", label: "Remboursée" },
];

const ADMIN_ROLE_OPTIONS = [
    { value: "admin", label: "Admin" },
    { value: "superadmin", label: "Superadmin" },
];

function getOrderStatusLabel(status) {
    return ORDER_STATUS_OPTIONS.find((option) => option.value === status)?.label || status;
}

function getOrderStatusTone(status) {
    if (["paid", "completed", "ready_for_pickup"].includes(status)) {
        return "success";
    }

    if (["cancelled", "failed", "refunded"].includes(status)) {
        return "danger";
    }

    if (["processing", "shipped"].includes(status)) {
        return "info";
    }

    return "muted";
}

function getAdminRoleLabel(role) {
    return ADMIN_ROLE_OPTIONS.find((option) => option.value === role)?.label || role;
}

function getOrderProviderLabel(provider) {
    if (provider === "stripe") {
        return "Carte bancaire (Stripe)";
    }

    if (provider === "manual") {
        return "Commande manuelle";
    }

    if (provider === "transfer") {
        return "Virement bancaire";
    }

    if (provider === "cash") {
        return "Paiement en espèces";
    }

    if (provider === "swissbitcoinpay") {
        return "Bitcoin (Swiss Bitcoin Pay)";
    }

    return provider;
}

function formatDateTime(value) {
    if (!value) {
        return "";
    }

    return new Intl.DateTimeFormat("fr-CH", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));
}

module.exports = {
    SHIPPING_OPTIONS,
    PAYMENT_DISCOUNT_RATE,
    ORDER_STATUS_OPTIONS,
    ADMIN_ROLE_OPTIONS,
    formatMoney,
    formatProductPrice,
    getOrderStatusLabel,
    getOrderStatusTone,
    getAdminRoleLabel,
    getOrderProviderLabel,
    formatDateTime,
};
