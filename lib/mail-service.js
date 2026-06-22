const nodemailer = require("nodemailer");

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatEmailHtml(text) {
    return String(text || "")
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
        .join("");
}

function createMailService(options) {
    const {
        env,
        getSettings,
        normalizeText,
        parseInteger,
        toBoolean,
        formatMoney,
        formatDateTime,
        getOrderContactSnapshot,
        getOrderProviderLabel,
        getOrderStatusLabel,
    } = options;

    function getMailSettings(settings) {
        return {
            host: normalizeText(settings.smtp_host || env.SMTP_HOST),
            port: parseInteger(settings.smtp_port || env.SMTP_PORT, 587),
            secure: toBoolean(settings.smtp_secure || env.SMTP_SECURE),
            username: normalizeText(settings.smtp_username || env.SMTP_USERNAME),
            password: String(settings.smtp_password || env.SMTP_PASSWORD || "").trim(),
            fromName: normalizeText(settings.smtp_from_name || env.SMTP_FROM_NAME || settings.store_name || "RecyTech"),
            fromEmail: normalizeText(settings.smtp_from_email || env.SMTP_FROM_EMAIL || settings.support_email),
        };
    }

    function getMailConfigError(settings) {
        const config = getMailSettings(settings);

        if (!config.host) {
            return "Serveur SMTP manquant.";
        }

        if (!config.port) {
            return "Port SMTP invalide.";
        }

        if (!config.fromEmail) {
            return "Adresse expéditeur manquante.";
        }

        if ((config.username && !config.password) || (!config.username && config.password)) {
            return "Les identifiants SMTP sont incomplets.";
        }

        return "";
    }

    function isMailConfigured(settings) {
        return !getMailConfigError(settings);
    }

    function buildOrderEmailDraft(order) {
        return {
            subject: `Commande ${order.order_number}`,
            message: [
                `Bonjour ${order.customer_name},`,
                "",
                `Nous vous contactons au sujet de votre commande ${order.order_number}.`,
                "",
                "Bien à vous,",
                "RecyTech",
            ].join("\n"),
        };
    }

    function getOrderNotificationRecipient(settings) {
        return normalizeText(settings.order_notification_email || env.ORDER_NOTIFICATION_EMAIL || "team@recytech.me");
    }

    function formatOrderNotificationItems(order) {
        return (order.items || []).map((item) => {
            const optionText = Array.isArray(item.selected_options) && item.selected_options.length
                ? ` (${item.selected_options.map((option) => `${option.name}: ${option.value}`).join(", ")})`
                : "";
            return `- ${item.quantity} x ${item.name}${optionText} : ${formatMoney(item.line_total_cents || (item.unit_price_cents * item.quantity), order.currency)}`;
        }).join("\n");
    }

    function buildNewOrderNotification(order) {
        const contact = getOrderContactSnapshot(order);
        const delivery = order.metadata?.delivery || {};
        const deliveryLabel = delivery.label || (delivery.method === "ship" ? "Expédition" : "Retrait");
        const additions = Array.isArray(order.metadata?.additions) ? order.metadata.additions : [];
        const additionsText = additions.length
            ? additions.map((line) => `- ${line.label} : ${formatMoney(line.amount_cents, order.currency)}`).join("\n")
            : "Aucun supplément";
        const adminUrl = `${env.BASE_URL || ""}/admin/orders/${order.id}`;

        return {
            subject: `Nouvelle commande ${order.order_number}`,
            text: [
                "Une nouvelle commande a été enregistrée sur la boutique RecyTech.",
                "",
                `Numéro : ${order.order_number}`,
                `Date : ${formatDateTime(order.created_at)}`,
                `Client : ${order.customer_name}`,
                `E-mail : ${order.customer_email}`,
                contact.phone ? `Téléphone : ${contact.phone}` : null,
                `Paiement : ${getOrderProviderLabel(order.provider)}`,
                `Statut : ${getOrderStatusLabel(order.status)}`,
                `Total : ${formatMoney(order.amount_cents, order.currency)}`,
                `Livraison : ${deliveryLabel}`,
                "",
                "Articles :",
                formatOrderNotificationItems(order) || "- Aucun article",
                "",
                "Suppléments :",
                additionsText,
                contact.shippingLines.length ? "" : null,
                contact.shippingLines.length ? "Adresse de livraison :" : null,
                ...(contact.shippingLines.length ? contact.shippingLines : []),
                contact.billingLines.length ? "" : null,
                contact.billingLines.length ? "Adresse de facturation :" : null,
                ...(contact.billingLines.length ? contact.billingLines : []),
                adminUrl.startsWith("http") ? "" : null,
                adminUrl.startsWith("http") ? `Administration : ${adminUrl}` : null,
            ].filter(Boolean).join("\n"),
        };
    }

    async function sendStoreEmail(settings, message) {
        const configError = getMailConfigError(settings);
        if (configError) {
            throw new Error(configError);
        }

        const config = getMailSettings(settings);
        const transporter = nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure,
            auth: config.username ? { user: config.username, pass: config.password } : undefined,
        });

        return transporter.sendMail({
            from: {
                name: config.fromName,
                address: config.fromEmail,
            },
            replyTo: settings.support_email || config.fromEmail,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: formatEmailHtml(message.text),
        });
    }

    async function sendNewOrderNotification(order) {
        const settings = getSettings();
        const recipient = getOrderNotificationRecipient(settings);

        if (!recipient || !isMailConfigured(settings)) {
            return;
        }

        const notification = buildNewOrderNotification(order);
        await sendStoreEmail(settings, {
            to: recipient,
            subject: notification.subject,
            text: notification.text,
        });
    }

    return {
        getMailConfigError,
        isMailConfigured,
        buildOrderEmailDraft,
        sendStoreEmail,
        sendNewOrderNotification,
    };
}

module.exports = { createMailService };
