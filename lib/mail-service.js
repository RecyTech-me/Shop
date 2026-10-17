const nodemailer = require("nodemailer");
const { hasRecordedPayment } = require("./order-statuses");

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
        // SMTP is one configuration: do not mix database defaults with environment credentials.
        const source = normalizeText(settings.smtp_host) ? settings : {
            smtp_host: env.SMTP_HOST,
            smtp_port: env.SMTP_PORT,
            smtp_secure: env.SMTP_SECURE,
            smtp_username: env.SMTP_USERNAME,
            smtp_password: env.SMTP_PASSWORD,
        };
        return {
            host: normalizeText(source.smtp_host),
            port: parseInteger(String(source.smtp_port || "587").trim(), 0),
            secure: toBoolean(source.smtp_secure),
            username: normalizeText(source.smtp_username),
            password: String(source.smtp_password || ""),
            fromName: normalizeText(settings.smtp_from_name || env.SMTP_FROM_NAME || settings.store_name || "RecyTech"),
            fromEmail: normalizeText(settings.smtp_from_email || env.SMTP_FROM_EMAIL || settings.support_email),
        };
    }

    function getMailConfigError(settings) {
        const config = getMailSettings(settings);

        if (!config.host) {
            return "Serveur SMTP manquant.";
        }

        if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
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
        const publicUrl = String(env.SHOP_PUBLIC_URL || env.BASE_URL || "").trim().replace(/\/+$/, "");
        const adminUrl = `${publicUrl}/admin/orders/${order.id}`;

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

    function createTransport(settings) {
        const configError = getMailConfigError(settings);
        if (configError) {
            throw new Error(configError);
        }

        const config = getMailSettings(settings);
        return nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure,
            requireTLS: env.NODE_ENV === "production" && !config.secure,
            auth: config.username ? { user: config.username, pass: config.password } : undefined,
            dnsTimeout: 10_000,
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 30_000,
        });
    }

    async function verifyMailConnection(settings) {
        const transporter = createTransport(settings);
        try {
            await transporter.verify();
        } finally {
            transporter.close?.();
        }
    }

    async function sendStoreEmail(settings, message) {
        const config = getMailSettings(settings);
        const transporter = createTransport(settings);
        try {
            const result = await transporter.sendMail({
                from: {
                    name: config.fromName,
                    address: config.fromEmail,
                },
                replyTo: settings.support_email || config.fromEmail,
                to: message.to,
                subject: message.subject,
                text: message.text,
                html: formatEmailHtml(message.text),
                ...(message.messageId ? { messageId: message.messageId } : {}),
            });
            if (Array.isArray(result.accepted) && !result.accepted.length) {
                const error = new Error("Le serveur SMTP n'a accepté aucun destinataire.");
                error.code = "EENVELOPE";
                throw error;
            }
            return result;
        } finally {
            transporter.close?.();
        }
    }

    function buildCustomerConfirmation(order) {
        const settings = getSettings();
        const paid = hasRecordedPayment(order);
        let paymentText = paid ? "Paiement reçu." : "Votre paiement n'est pas encore confirmé.";
        if (!paid && order.provider === "cash") {
            paymentText = "Le paiement en espèces se fera lors du retrait.";
        } else if (!paid && order.provider === "transfer") {
            paymentText = [
                "Votre commande est en attente de votre virement bancaire.",
                settings.bank_account_holder ? `Titulaire : ${settings.bank_account_holder}` : "",
                settings.bank_iban ? `IBAN : ${settings.bank_iban}` : "",
                `Référence à indiquer : ${order.order_number}`,
            ].filter(Boolean).join("\n");
        }
        const additions = order.metadata?.additions || [];
        return {
            subject: `Commande reçue ${order.order_number}`,
            text: [
                `Bonjour ${order.customer_name},`,
                "",
                `Nous avons bien reçu votre commande ${order.order_number}.`,
                "",
                formatOrderNotificationItems(order),
                ...additions.map((line) => `${line.label} : ${formatMoney(line.amount_cents, order.currency)}`),
                `Total : ${formatMoney(order.amount_cents, order.currency)}`,
                `Livraison : ${order.metadata?.delivery?.label || "À convenir"}`,
                `Mode de paiement : ${getOrderProviderLabel(order.provider)}`,
                paymentText,
                "",
                "Cet e-mail confirme la réception de votre commande. Il ne constitue pas une confirmation de paiement, sauf mention explicite ci-dessus.",
                "Pour toute question, vous pouvez répondre à cet e-mail.",
                "",
                settings.store_name || "RecyTech",
            ].join("\n"),
        };
    }

    async function sendOrderMail(order, kind) {
        const settings = getSettings();
        const message = kind === "customer" ? buildCustomerConfirmation(order) : buildNewOrderNotification(order);
        return sendStoreEmail(settings, {
            ...message,
            to: kind === "customer" ? order.customer_email : getOrderNotificationRecipient(settings),
            messageId: `<order-${order.order_number}-${kind}@recytech.me>`,
        });
    }

    async function sendNewOrderNotification(order) {
        const settings = getSettings();
        const recipient = getOrderNotificationRecipient(settings);

        if (!recipient) {
            throw new Error("Destinataire de notification manquant.");
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
        verifyMailConnection,
        buildCustomerConfirmation,
        sendOrderMail,
        isMailConfigured,
        buildOrderEmailDraft,
        sendStoreEmail,
        sendNewOrderNotification,
    };
}

module.exports = { createMailService };
