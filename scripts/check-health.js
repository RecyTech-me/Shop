const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

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

async function postAlert(webhookUrl, payload) {
    if (!webhookUrl) {
        return;
    }

    const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`Alert webhook returned HTTP ${response.status}`);
    }
}

async function checkHealth({
    healthUrl = defaultHealthUrl(),
    alertWebhookUrl = process.env.ALERT_WEBHOOK_URL,
} = {}) {
    try {
        const response = await fetch(healthUrl, {
            headers: {
                Accept: "application/json",
            },
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
        const alertPayload = buildAlertPayload({
            url: healthUrl,
            error,
            statusCode: error.statusCode || null,
        });

        try {
            await postAlert(alertWebhookUrl, alertPayload);
        } catch (alertError) {
            console.error(`Health alert failed: ${alertError.message}`);
        }
        throw error;
    }
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
};
