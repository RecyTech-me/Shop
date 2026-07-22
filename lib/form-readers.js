const { ADMIN_ROLE_OPTIONS } = require("./shop-formatters");
const {
    normalizeText,
    normalizeSingleLineText,
    truncateText,
    parseInteger,
    parseMoneyToCents,
    normalizeDateField,
} = require("./input-utils");

const ADMIN_PASSWORD_MIN_LENGTH = 12;
const ADMIN_PASSWORD_MAX_LENGTH = 128;

function validateAdminPassword(password) {
    if (!password) {
        return;
    }

    if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
        throw new Error(`Le mot de passe doit contenir au moins ${ADMIN_PASSWORD_MIN_LENGTH} caractères.`);
    }

    if (password.length > ADMIN_PASSWORD_MAX_LENGTH) {
        throw new Error(`Le mot de passe ne peut pas dépasser ${ADMIN_PASSWORD_MAX_LENGTH} caractères.`);
    }
}

function readAdminUserInput(values, options = {}) {
    const username = normalizeText(values.username);
    const role = normalizeText(values.role) || "admin";
    const password = String(values.password || "").trim();

    if (!username) {
        throw new Error("Le nom d'utilisateur est obligatoire.");
    }

    if (!ADMIN_ROLE_OPTIONS.some((option) => option.value === role)) {
        throw new Error("Rôle administrateur invalide.");
    }

    if (options.requirePassword && !password) {
        throw new Error("Le mot de passe est obligatoire.");
    }
    validateAdminPassword(password);

    return {
        username,
        role,
        password,
    };
}

function readAdminAccountInput(values, currentAdmin) {
    const username = normalizeText(values.username);
    const currentPassword = String(values.current_password || "").trim();
    const password = String(values.password || "").trim();
    const passwordConfirm = String(values.password_confirm || "").trim();

    if (!username) {
        throw new Error("Le nom d'utilisateur est obligatoire.");
    }

    if (password && password !== passwordConfirm) {
        throw new Error("La confirmation du nouveau mot de passe ne correspond pas.");
    }
    validateAdminPassword(password);

    const usernameChanged = username !== currentAdmin.username;
    const passwordChanged = Boolean(password);

    if ((usernameChanged || passwordChanged) && !currentPassword) {
        throw new Error("Le mot de passe actuel est requis pour modifier vos identifiants.");
    }

    return {
        username,
        currentPassword,
        password,
        usernameChanged,
        passwordChanged,
    };
}

function readSiteReviewInput(values) {
    const rating = parseInteger(values.rating, NaN);
    const reviewerName = truncateText(values.reviewer_name, 80);
    const reviewerEmail = normalizeSingleLineText(values.reviewer_email).slice(0, 160);
    const title = truncateText(values.title, 120);
    const body = truncateText(values.body, 1200);

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new Error("Choisissez une note entre 1 et 5.");
    }

    if (!reviewerName) {
        throw new Error("Votre nom est obligatoire.");
    }

    if (reviewerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reviewerEmail)) {
        throw new Error("Adresse e-mail invalide.");
    }

    if (body.length < 10) {
        throw new Error("Votre avis doit contenir au moins 10 caractères.");
    }

    return {
        rating,
        reviewer_name: reviewerName,
        reviewer_email: reviewerEmail,
        title,
        body,
    };
}

function readPromoCodeInput(values, normalizePromoCode) {
    const code = normalizePromoCode(values.code);
    const description = normalizeText(values.description);
    const discountType = normalizeText(values.discount_type);
    const amountValue = String(values.amount_value || "").trim();
    const minimumOrderRaw = String(values.minimum_order_chf || "").trim();
    const minimumOrderCents = minimumOrderRaw ? parseMoneyToCents(minimumOrderRaw, NaN) : 0;
    const maxRedemptionsRaw = String(values.max_redemptions || "").trim();
    const startsOnRaw = normalizeText(values.starts_on);
    const expiresOnRaw = normalizeText(values.expires_on);
    const startsOn = normalizeDateField(values.starts_on);
    const expiresOn = normalizeDateField(values.expires_on);

    if (!code) {
        throw new Error("Le code promo est obligatoire.");
    }

    if (!["percent", "fixed"].includes(discountType)) {
        throw new Error("Le type de remise est invalide.");
    }

    if (startsOnRaw && !startsOn) {
        throw new Error("La date de début est invalide.");
    }

    if (expiresOnRaw && !expiresOn) {
        throw new Error("La date de fin est invalide.");
    }

    if (!Number.isFinite(minimumOrderCents) || minimumOrderCents < 0) {
        throw new Error("Le minimum de commande est invalide.");
    }

    let discountValue = 0;

    if (discountType === "percent") {
        const parsedPercent = parseInteger(amountValue, NaN);
        if (!Number.isFinite(parsedPercent) || parsedPercent <= 0 || parsedPercent > 100) {
            throw new Error("Le pourcentage doit être compris entre 1 et 100.");
        }

        discountValue = parsedPercent;
    } else {
        discountValue = parseMoneyToCents(amountValue, NaN);
        if (!Number.isFinite(discountValue) || discountValue <= 0) {
            throw new Error("Le montant fixe doit être supérieur à 0.");
        }
    }

    let maxRedemptions = null;
    if (maxRedemptionsRaw) {
        maxRedemptions = parseInteger(maxRedemptionsRaw, NaN);
        if (!Number.isFinite(maxRedemptions) || maxRedemptions <= 0) {
            throw new Error("La limite d'utilisation doit être un entier positif.");
        }
    }

    if (startsOn && expiresOn && startsOn > expiresOn) {
        throw new Error("La date de fin doit être postérieure à la date de début.");
    }

    return {
        code,
        description,
        discount_type: discountType,
        discount_value: discountValue,
        minimum_order_cents: minimumOrderCents,
        max_redemptions: maxRedemptions,
        starts_on: startsOn || null,
        expires_on: expiresOn || null,
        active: values.active ? 1 : 0,
    };
}

function createFormReaders({ normalizePromoCode }) {
    return {
        readAdminUserInput,
        readAdminAccountInput,
        readSiteReviewInput,
        readPromoCodeInput: (values) => readPromoCodeInput(values, normalizePromoCode),
    };
}

module.exports = {
    createFormReaders,
    readAdminUserInput,
    readAdminAccountInput,
    readSiteReviewInput,
    readPromoCodeInput,
    validateAdminPassword,
};
