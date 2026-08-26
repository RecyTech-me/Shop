const assert = require("node:assert/strict");
const test = require("node:test");
const {
    buildOrderDocumentFilename,
    buildOrderDocumentPdf,
} = require("../lib/order-documents");

const sampleOrder = {
    id: 7,
    order_number: "RT-2026-0007",
    provider: "transfer",
    status: "paid",
    customer_name: "Élodie Exemple",
    customer_email: "elodie@example.test",
    amount_cents: 129900,
    received_amount_cents: 130000,
    currency: "CHF",
    created_at: "2026-06-22T10:00:00.000Z",
    paid_at: "2026-06-22T10:30:00.000Z",
    metadata: {
        checkout: {
            customer_first_name: "Élodie",
            customer_last_name: "Exemple",
            shipping_address1: "Rue du Test 1",
            shipping_postal_code: "2000",
            shipping_city: "Neuchâtel",
            shipping_country: "Suisse",
            billing_same_as_shipping: "1",
        },
        additions: [{
            label: "Réduction retrait espèces (-10%)",
            amount_cents: -1000,
        }],
        delivery: {
            method: "ship",
            label: "Expédition",
            amount_cents: 900,
        },
    },
    items: [{
        name: "ThinkPad T480 reconditionné",
        quantity: 2,
        unit_price_cents: 65000,
        line_total_cents: 130000,
        selected_options: [{ name: "RAM", value: "16 GB" }],
        service_tags: ["PF-123", "PF-456"],
    }],
};

const settings = {
    store_name: "RecyTech",
    store_legal_name: "RecyTech SNC",
    store_address: "Rue du Test 1",
    store_postal_city: "2000 Neuchâtel",
    support_email: "support@example.test",
    support_phone: "+41 32 000 00 00",
};

function renderPdf(type) {
    return buildOrderDocumentPdf({
        type,
        order: sampleOrder,
        settings,
        contact: {
            shippingLines: ["Élodie Exemple", "Rue du Test 1", "2000 Neuchâtel", "Suisse"],
            billingLines: ["Élodie Exemple", "Rue du Test 1", "2000 Neuchâtel", "Suisse"],
            phone: "+41 32 000 00 00",
        },
        admin: { username: "admin" },
        getOrderStatusLabel: (status) => status,
        getOrderProviderLabel: (provider) => provider,
        baseUrl: "https://shop.recytech.me",
        config: {},
    });
}

function extractPdfText(pdf) {
    return [...pdf.toString("latin1").matchAll(/<([0-9A-F]+)> Tj/g)]
        .map((match) => Buffer.from(match[1], "hex").toString("latin1"))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim();
}

test("order document PDFs render valid PDF bytes", () => {
    for (const type of ["invoice", "delivery-slip", "shipping-label"]) {
        const pdf = renderPdf(type);
        const text = pdf.toString("latin1");

        assert.ok(Buffer.isBuffer(pdf));
        assert.ok(text.startsWith("%PDF-1.4"));
        assert.match(text, /\/Type \/Page/);
        assert.ok(pdf.length > 1000);
    }
});

test("shipping label is A6 and contains only the postal address and internal reference", () => {
    const pdf = renderPdf("shipping-label");
    const rawPdf = pdf.toString("latin1");
    const text = extractPdfText(pdf);

    assert.match(rawPdf, /\/MediaBox \[0 0 297\.64 419\.53\]/);
    assert.match(text, /ÉTIQUETTE D'ADRESSE/);
    assert.match(text, /EXPÉDITEUR/);
    assert.match(text, /DESTINATAIRE/);
    assert.match(text, /Élodie Exemple/);
    assert.match(text, /Rue du Test 1/);
    assert.match(text, /2000 Neuchâtel/);
    assert.match(text, /Commande : RT-2026-0007/);
    assert.match(text, /À affranchir - aucun code-barres postal inclus/);
    assert.doesNotMatch(text, /elodie@example\.test/);
    assert.doesNotMatch(text, /\+41 32 000 00 00/);
    assert.doesNotMatch(text, /1 299\.00 CHF/);
});

test("invoice PDF includes core order, customer, item, and payment text", () => {
    const text = extractPdfText(renderPdf("invoice"));

    assert.match(text, /FACTURE/);
    assert.match(text, /F-RT-2026-0007/);
    assert.match(text, /Élodie Exemple/);
    assert.match(text, /ThinkPad T480 reconditionné/);
    assert.match(text, /RAM: 16 GB/);
    assert.match(text, /1 299\.00 CHF/);
    assert.match(text, /Informations de paiement/);
    assert.match(text, /Titulaire du compte/);
    assert.match(text, /Montant : 1 299\.00 CHF/);
    assert.match(text, /Communication : RT-2026-0007/);
    assert.doesNotMatch(text, /Swiss QR-bill/);
    assert.doesNotMatch(text, /placeholder/);
    assert.match(text, /Conditions générales de vente/);
});

test("delivery slip PDF includes fulfillment text without invoice totals", () => {
    const text = extractPdfText(renderPdf("delivery-slip"));

    assert.match(text, /BON DE LIVRAISON/);
    assert.match(text, /BL-RT-2026-0007/);
    assert.match(text, /Mode : Expédition/);
    assert.match(text, /ThinkPad T480 reconditionné/);
    assert.match(text, /Remis \/ reçu par/);
    assert.doesNotMatch(text, /Prix unit\./);
    assert.doesNotMatch(text, /1 299\.00 CHF/);
});

test("document filenames are sanitized and type-specific", () => {
    assert.equal(buildOrderDocumentFilename(sampleOrder, "invoice"), "F-RT-2026-0007.pdf");
    assert.equal(buildOrderDocumentFilename(sampleOrder, "delivery-slip"), "BL-RT-2026-0007.pdf");
    assert.equal(buildOrderDocumentFilename(sampleOrder, "shipping-label"), "ETIQUETTE-RT-2026-0007.pdf");
});
