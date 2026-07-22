const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

function defaultHealthUrl(env = process.env) {
    const healthUrl = String(env.HEALTHCHECK_URL || "").trim();
    if (healthUrl) {
        return healthUrl;
    }

    const baseUrl = String(env.SHOP_PUBLIC_URL || env.BASE_URL || "").trim();
    if (baseUrl) {
        return baseUrl.endsWith("/healthz") ? baseUrl : `${baseUrl.replace(/\/+$/, "")}/healthz`;
    }

    return `http://127.0.0.1:${env.PORT || 3000}/healthz`;
}

function isHealthyPayload(payload) {
    return payload?.status === "ok" && payload?.checks?.database === "ok";
}

function readPositiveInteger(value, fallback) {
    const normalized = String(value ?? "").trim();
    const parsed = /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildAlertPayload({ url, error, statusCode = null }) {
    return {
        service: "recytech-shop-site",
        check: "healthz",
        url,
        status: "failed",
        statusCode,
        error: error?.message || String(error || "Unknown health check failure"),
        timestamp: new Date().toISOString(),
    };
}

async function postAlert(webhookUrl, payload, { fetchImpl = global.fetch, timeoutMs = 10_000 } = {}) {
    if (!webhookUrl) {
        return;
    }

    const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        throw new Error(`Alert webhook returned HTTP ${response.status}`);
    }
}

async function checkHealth({
    healthUrl = defaultHealthUrl(),
    alertWebhookUrl = process.env.ALERT_WEBHOOK_URL,
    fetchImpl = global.fetch,
    timeoutMs = 10_000,
    attempts = readPositiveInteger(process.env.HEALTHCHECK_ATTEMPTS, 1),
    retryDelayMs = readPositiveInteger(process.env.HEALTHCHECK_RETRY_DELAY_MS, 2_000),
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetchImpl(healthUrl, {
                headers: {
                    Accept: "application/json",
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
            const payload = await response.json().catch(() => null);

            if (!response.ok || !isHealthyPayload(payload)) {
                throw Object.assign(new Error(`Health check failed for ${healthUrl}`), {
                    statusCode: response.status,
                    payload,
                });
            }

            console.log(`Health check ok: ${healthUrl}`);
            return payload;
        } catch (error) {
            lastError = error;
            if (attempt < attempts) {
                await wait(retryDelayMs);
            }
        }
    }

    const alertPayload = buildAlertPayload({
        url: healthUrl,
        error: lastError,
        statusCode: lastError?.statusCode || null,
    });

    try {
        await postAlert(alertWebhookUrl, alertPayload, { fetchImpl, timeoutMs });
    } catch (alertError) {
        console.error(`Health alert failed: ${alertError.message}`);
    }
    throw lastError;
}

if (require.main === module) {
    checkHealth().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    buildAlertPayload,
    checkHealth,
    defaultHealthUrl,
    isHealthyPayload,
    readPositiveInteger,
};
