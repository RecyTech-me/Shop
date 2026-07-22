const assert = require("node:assert/strict");
const test = require("node:test");
const {
    formatDateTimeInputValue,
    normalizeDateField,
    normalizeOrderDateTimeField,
    normalizeSingleLineText,
    normalizeText,
    parseInteger,
    parseMoneyToCents,
    parseOptionalMoneyToCents,
    parseShopLocalDateTime,
    toBoolean,
    truncateText,
} = require("../lib/input-utils");

test("text helpers normalize whitespace and enforce length limits", () => {
    assert.equal(normalizeText("  value  "), "value");
    assert.equal(normalizeText(null), "");
    assert.equal(normalizeSingleLineText(" first\r\nsecond\nthird "), "first second third");
    assert.equal(truncateText("  abcdef  ", 4), "abcd");
    assert.equal(truncateText(" short ", 10), "short");
});

test("boolean and integer parsing reject ambiguous values", () => {
    for (const value of ["1", "true", "YES", " on "]) {
        assert.equal(toBoolean(value), true);
    }
    assert.equal(toBoolean("off"), false);
    assert.equal(parseInteger(0, 99), 0);
    assert.equal(parseInteger("-12", 0), -12);
    assert.equal(parseInteger("12px", 99), 99);
    assert.equal(parseInteger("1.5", 99), 99);
    assert.equal(parseInteger("999999999999999999999", 99), 99);
});

test("money parsing supports decimal separators and rejects partial numbers", () => {
    assert.equal(parseMoneyToCents("12.345"), 1235);
    assert.equal(parseMoneyToCents(0, 7), 0);
    assert.equal(parseMoneyToCents("12,50"), 1250);
    assert.equal(parseMoneyToCents(".75"), 75);
    assert.equal(parseMoneyToCents("-1.20"), -120);
    assert.equal(parseMoneyToCents("10 CHF", 7), 7);
    assert.equal(parseMoneyToCents("1.2.3", 7), 7);
    assert.equal(parseMoneyToCents("", 7), 7);
});

test("optional money parsing distinguishes empty, invalid, and valid amounts", () => {
    assert.equal(parseOptionalMoneyToCents("", "Montant"), null);
    assert.equal(parseOptionalMoneyToCents("10.20", "Montant"), 1020);
    assert.throws(() => parseOptionalMoneyToCents("invalid", "Montant"), /Montant invalide/);
    assert.throws(() => parseOptionalMoneyToCents("-1", "Montant"), /Montant invalide/);
});

test("date helpers reject impossible dates and normalize valid timestamps", () => {
    assert.equal(normalizeDateField("2024-02-29"), "2024-02-29");
    assert.equal(normalizeDateField("2025-02-29"), "");
    assert.equal(normalizeDateField("2026-13-01"), "");
    assert.equal(normalizeDateField("21.07.2026"), "");

    assert.equal(normalizeOrderDateTimeField("", "fallback"), "fallback");
    assert.equal(
        normalizeOrderDateTimeField("2026-07-21T12:30:00+02:00"),
        "2026-07-21T10:30:00.000Z"
    );
    assert.equal(normalizeOrderDateTimeField("2026-07-21T12:30"), "2026-07-21T10:30:00.000Z");
    assert.equal(normalizeOrderDateTimeField("2026-01-21T12:30"), "2026-01-21T11:30:00.000Z");
    assert.equal(parseShopLocalDateTime("2026-03-29T02:30"), null);
    assert.throws(
        () => normalizeOrderDateTimeField("2026-03-29T02:30"),
        /Date de commande invalide/
    );
    assert.throws(() => normalizeOrderDateTimeField("not-a-date"), /Date de commande invalide/);
    assert.equal(formatDateTimeInputValue("not-a-date"), "");
    assert.equal(formatDateTimeInputValue("2026-07-21T12:30:00.000Z"), "2026-07-21T14:30");
    assert.equal(formatDateTimeInputValue("2026-01-21T12:30:00.000Z"), "2026-01-21T13:30");
});
