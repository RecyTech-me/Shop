const crypto = require("crypto");

const DEFAULT_API_URL = "https://api.swiss-bitcoin-pay.ch";
const WEBHOOK_SECRET_HEADER = "x-recytech-webhook-secret";

function mapSwissBitcoinPayStatus(invoice) {
    const normalized = String(invoice?.status || "").toLowerCase();

    if (invoice?.isPaid || normalized === "paid") {
        return "paid";
    }

    if (invoice?.isExpired || normalized === "expired") {
        return "failed";
    }

    return "pending";
}

function buildSwissBitcoinPayDescription(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const preview = items.slice(0, 3).map((item) => `${item.quantity} x ${item.name}`);

    if (items.length > 3) {
        preview.push(`+${items.length - 3} autre(s) article(s)`);
    }

    return preview.join(", ") || `Commande ${order.order_number}`;
}

function timingSafeEqualText(actual, expected) {
    const actualBuffer = Buffer.from(String(actual || ""), "utf8");
    const expectedBuffer = Buffer.from(String(expected || ""), "utf8");

    if (!actualBuffer.length || actualBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function verifySwissBitcoinPaySignature(rawBody, signatureHeader, webhookSecret) {
    if (!webhookSecret) {
        return false;
    }

    const signature = String(signatureHeader || "").trim();
    if (!signature) {
        return false;
    }

    const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
    const digest = crypto.createHmac("sha256", webhookSecret).update(payload).digest();
    const candidates = [signature, signature.replace(/^sha256=/i, "").trim()].filter(Boolean);

    for (const candidate of candidates) {
        if (/^[a-f0-9]+$/i.test(candidate) && candidate.length === digest.length * 2) {
            const buffer = Buffer.from(candidate, "hex");
            if (buffer.length === digest.length && crypto.timingSafeEqual(buffer, digest)) {
                return true;
            }
        }

        const normalizedBase64 = candidate.replace(/-/g, "+").replace(/_/g, "/");
        const paddedBase64 = normalizedBase64 + "=".repeat((4 - (normalizedBase64.length % 4 || 4)) % 4);

        try {
            const buffer = Buffer.from(paddedBase64, "base64");
            if (buffer.length === digest.length && crypto.timingSafeEqual(buffer, digest)) {
                return true;
            }
        } catch (_error) {
            // Ignore invalid encodings and keep trying supported formats.
        }
    }

    return false;
}

function createSwissBitcoinPayService({
    apiUrl = DEFAULT_API_URL,
    apiKey = "",
    webhookSecret = "",
    webhookSecretHeader = WEBHOOK_SECRET_HEADER,
    baseUrl,
    createOrderViewToken,
}) {
    const normalizedApiUrl = String(apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
    const normalizedApiKey = String(apiKey || "").trim();
    const normalizedWebhookSecret = String(webhookSecret || "").trim();

    async function createInvoice(order, req) {
        const response = await fetch(
            `${normalizedApiUrl}/checkout`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "api-key": normalizedApiKey,
                },
                body: JSON.stringify({
                    amount: Number((order.amount_cents / 100).toFixed(2)),
                    title: `Commande ${order.order_number}`,
                    description: buildSwissBitcoinPayDescription(order),
                    unit: order.currency,
                    onChain: true,
                    delay: 10,
                    email: order.customer_email,
                    emailLanguage: "fr",
                    redirect: false,
                    redirectAfterPaid: `${baseUrl(req)}/checkout/success?provider=swissbitcoinpay&order=${encodeURIComponent(order.order_number)}&view=${encodeURIComponent(createOrderViewToken(order))}`,
                    webhook: {
                        url: `${baseUrl(req)}/webhooks/swiss-bitcoin-pay`,
                        headers: {
                            [webhookSecretHeader]: normalizedWebhookSecret,
                        },
                    },
                    device: {
                        name: "RecyTech Shop",
                        type: "website",
                    },
                    extra: {
                        orderNumber: order.order_number,
                    },
                }),
            }
        );

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Swiss Bitcoin Pay invoice creation failed: ${response.status} ${text}`);
        }

        const invoice = await response.json();

        if (!invoice?.checkoutUrl) {
            throw new Error("Swiss Bitcoin Pay n'a pas retourné d'URL de paiement.");
        }

        return invoice;
    }

    async function fetchInvoice(invoiceId) {
        const response = await fetch(`${normalizedApiUrl}/checkout/${encodeURIComponent(invoiceId)}`);

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Swiss Bitcoin Pay invoice fetch failed: ${response.status} ${text}`);
        }

        return response.json();
    }

    function verifyWebhook(req) {
        if (!normalizedWebhookSecret) {
            return false;
        }

        const customSecret = Array.isArray(req.headers[webhookSecretHeader])
            ? req.headers[webhookSecretHeader][0]
            : req.headers[webhookSecretHeader];

        if (timingSafeEqualText(customSecret, normalizedWebhookSecret)) {
            return true;
        }

        // Backward-compatible fallback for older/manual integrations that send an HMAC signature.
        return verifySwissBitcoinPaySignature(req.body, req.headers["sbp-sig"], normalizedWebhookSecret);
    }

    return {
        apiKey: normalizedApiKey,
        webhookSecret: normalizedWebhookSecret,
        webhookSecretHeader,
        createInvoice,
        fetchInvoice,
        verifyWebhook,
    };
}

module.exports = {
    WEBHOOK_SECRET_HEADER,
    mapSwissBitcoinPayStatus,
    createSwissBitcoinPayService,
};
