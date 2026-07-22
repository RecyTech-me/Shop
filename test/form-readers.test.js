const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createFormReaders,
    readAdminAccountInput,
    readAdminUserInput,
    readPromoCodeInput,
    readSiteReviewInput,
} = require("../lib/form-readers");

const normalizePromoCode = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, "");

test("admin user input applies defaults and validates required credentials", () => {
    assert.deepEqual(readAdminUserInput({
        username: "  operator  ",
        password: "  secure-secret  ",
    }), {
        username: "operator",
        role: "admin",
        password: "secure-secret",
    });

    assert.throws(
        () => readAdminUserInput({ username: "", role: "admin" }),
        /nom d'utilisateur est obligatoire/
    );
    assert.throws(
        () => readAdminUserInput({ username: "operator", role: "owner" }),
        /Rôle administrateur invalide/
    );
    assert.throws(
        () => readAdminUserInput({ username: "operator", role: "admin" }, { requirePassword: true }),
        /mot de passe est obligatoire/
    );
    assert.throws(
        () => readAdminUserInput({ username: "operator", password: "too-short" }),
        /au moins 12 caractères/
    );
});

test("admin account input requires confirmation and the current password for credential changes", () => {
    const currentAdmin = { username: "admin" };

    assert.deepEqual(readAdminAccountInput({ username: "admin" }, currentAdmin), {
        username: "admin",
        currentPassword: "",
        password: "",
        usernameChanged: false,
        passwordChanged: false,
    });
    assert.throws(
        () => readAdminAccountInput({ username: "", current_password: "old" }, currentAdmin),
        /nom d'utilisateur est obligatoire/
    );
    assert.throws(
        () => readAdminAccountInput({
            username: "admin",
            password: "new-password",
            password_confirm: "different",
            current_password: "old-password",
        }, currentAdmin),
        /confirmation du nouveau mot de passe/
    );
    assert.throws(
        () => readAdminAccountInput({ username: "renamed-admin" }, currentAdmin),
        /mot de passe actuel est requis/
    );
    assert.throws(
        () => readAdminAccountInput({
            username: "admin",
            password: "short",
            password_confirm: "short",
            current_password: "old-password",
        }, currentAdmin),
        /au moins 12 caractères/
    );
});

test("site review input normalizes valid content and enforces its boundaries", () => {
    const review = readSiteReviewInput({
        rating: "5",
        reviewer_name: `  ${"N".repeat(90)}  `,
        reviewer_email: " buyer@example.test\n",
        title: "  Excellent  ",
        body: "  Produit conforme et livraison rapide.  ",
    });

    assert.equal(review.rating, 5);
    assert.equal(review.reviewer_name.length, 80);
    assert.equal(review.reviewer_email, "buyer@example.test");
    assert.equal(review.title, "Excellent");
    assert.equal(review.body, "Produit conforme et livraison rapide.");

    assert.throws(() => readSiteReviewInput({ rating: "0" }), /note entre 1 et 5/);
    assert.throws(() => readSiteReviewInput({ rating: "5stars" }), /note entre 1 et 5/);
    assert.throws(() => readSiteReviewInput({ rating: "5", reviewer_name: "" }), /nom est obligatoire/);
    assert.throws(() => readSiteReviewInput({
        rating: "5",
        reviewer_name: "Client",
        reviewer_email: "invalid-address",
        body: "Un commentaire suffisamment long",
    }), /e-mail invalide/);
    assert.throws(() => readSiteReviewInput({
        rating: "5",
        reviewer_name: "Client",
        body: "Court",
    }), /au moins 10 caractères/);
});

test("promo code input parses percent and fixed discounts", () => {
    assert.deepEqual(readPromoCodeInput({
        code: " summer 25 ",
        description: " Promotion d'été ",
        discount_type: "percent",
        amount_value: "25",
        minimum_order_chf: "49.90",
        max_redemptions: "100",
        starts_on: "2026-07-01",
        expires_on: "2026-07-31",
        active: "on",
    }, normalizePromoCode), {
        code: "SUMMER25",
        description: "Promotion d'été",
        discount_type: "percent",
        discount_value: 25,
        minimum_order_cents: 4990,
        max_redemptions: 100,
        starts_on: "2026-07-01",
        expires_on: "2026-07-31",
        active: 1,
    });

    assert.equal(readPromoCodeInput({
        code: "SAVE10",
        discount_type: "fixed",
        amount_value: "10.50",
    }, normalizePromoCode).discount_value, 1050);
});

test("promo code input rejects malformed discounts, limits, and date ranges", () => {
    const read = (overrides = {}) => readPromoCodeInput({
        code: "VALID",
        discount_type: "percent",
        amount_value: "10",
        ...overrides,
    }, normalizePromoCode);

    assert.throws(() => read({ code: "" }), /code promo est obligatoire/);
    assert.throws(() => read({ discount_type: "bogus" }), /type de remise est invalide/);
    assert.throws(() => read({ amount_value: "101" }), /compris entre 1 et 100/);
    assert.throws(() => read({ discount_type: "fixed", amount_value: "0" }), /supérieur à 0/);
    assert.throws(() => read({ minimum_order_chf: "10 CHF" }), /minimum de commande est invalide/);
    assert.throws(() => read({ minimum_order_chf: "-1" }), /minimum de commande est invalide/);
    assert.throws(() => read({ max_redemptions: "-2" }), /entier positif/);
    assert.throws(() => read({ starts_on: "2026-08-01", expires_on: "2026-07-31" }), /date de fin/);

    assert.throws(() => read({ starts_on: "2026-02-30" }), /date de début est invalide/);
    assert.throws(() => read({ expires_on: "2026-13-01" }), /date de fin est invalide/);
});

test("form reader factory binds promo-code normalization", () => {
    const forms = createFormReaders({ normalizePromoCode });
    const input = forms.readPromoCodeInput({
        code: " factory code ",
        discount_type: "percent",
        amount_value: "15",
    });

    assert.equal(input.code, "FACTORYCODE");
});
