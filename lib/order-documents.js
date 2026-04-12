const fs = require("fs");
const path = require("path");

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 42;
const LOGO_SVG_PATH = path.join(__dirname, "..", "public", "images", "recytech-logo.svg");

const COLORS = {
    background: "#f4efe5",
    surface: "#fffdf8",
    surfaceAlt: "#f8f3ea",
    green: "#1f4b35",
    muted: "#5f7468",
    border: "#d8d0c1",
    white: "#ffffff",
};

const PAID_STATUSES = new Set(["paid", "processing", "ready_for_pickup", "shipped", "completed"]);
const BANK_TRANSFER_METHODS = new Set(["bank_transfer", "transfer"]);
const DEFAULT_IBAN_PLACEHOLDER = "CHXX XXXX XXXX XXXX XXXX X";
const PAYMENT_TERMS = "Payment within 30 days";
const VAT_NOTICE = "Entreprise non assujettie à la TVA selon l’art. 10 LTVA";
const WIN_ANSI_EXTRA_CHARS = new Map([
    ["\u2018", 0x91],
    ["\u2019", 0x92],
    ["\u201C", 0x93],
    ["\u201D", 0x94],
    ["\u2013", 0x96],
    ["\u2014", 0x97],
    ["\u2026", 0x85],
]);
let logoSvgCache = null;

function normalizeText(value) {
    return String(value || "").trim();
}

function normalizePdfText(value) {
    return String(value || "")
        .replace(/\u0153/g, "oe")
        .replace(/\u0152/g, "OE");
}

function encodePdfText(value) {
    const text = normalizePdfText(value);
    const bytes = [];

    for (const char of text) {
        const code = char.charCodeAt(0);
        if (code <= 255) {
            bytes.push(code);
            continue;
        }

        if (WIN_ANSI_EXTRA_CHARS.has(char)) {
            bytes.push(WIN_ANSI_EXTRA_CHARS.get(char));
            continue;
        }

        const fallback = char.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
        for (const fallbackChar of fallback) {
            const fallbackCode = fallbackChar.charCodeAt(0);
            bytes.push(fallbackCode <= 255 ? fallbackCode : 63);
        }
    }

    return `<${Buffer.from(bytes).toString("hex").toUpperCase()}>`;
}

function hexToRgb(color) {
    const normalized = String(color || "#000000").replace("#", "");
    const value = normalized.length === 3
        ? normalized.split("").map((part) => part + part).join("")
        : normalized.padEnd(6, "0").slice(0, 6);

    return [
        Number.parseInt(value.slice(0, 2), 16) / 255,
        Number.parseInt(value.slice(2, 4), 16) / 255,
        Number.parseInt(value.slice(4, 6), 16) / 255,
    ];
}

function rgbCommand(color, operator) {
    return `${hexToRgb(color).map((part) => part.toFixed(4)).join(" ")} ${operator}`;
}

function pdfNumber(value) {
    return Number(value || 0).toFixed(2);
}

class PdfDocument {
    constructor() {
        this.width = A4_WIDTH;
        this.height = A4_HEIGHT;
        this.pages = [];
        this.addPage();
    }

    addPage() {
        this.currentPage = [];
        this.pages.push(this.currentPage);
        this.rect(0, 0, this.width, this.height, {
            fill: COLORS.background,
            stroke: null,
        });
    }

    add(command) {
        this.currentPage.push(command);
    }

    rect(x, y, width, height, options = {}) {
        const fill = options.fill || null;
        const stroke = options.stroke === undefined ? COLORS.border : options.stroke;
        const lineWidth = options.lineWidth || 1;
        let operator = "S";

        if (fill && stroke) {
            operator = "B";
        } else if (fill) {
            operator = "f";
        }

        this.add([
            fill ? rgbCommand(fill, "rg") : "",
            stroke ? rgbCommand(stroke, "RG") : "",
            `${pdfNumber(lineWidth)} w`,
            `${pdfNumber(x)} ${pdfNumber(y)} ${pdfNumber(width)} ${pdfNumber(height)} re ${operator}`,
        ].filter(Boolean).join("\n"));
    }

    line(x1, y1, x2, y2, options = {}) {
        this.add([
            rgbCommand(options.color || COLORS.border, "RG"),
            `${pdfNumber(options.lineWidth || 1)} w`,
            `${pdfNumber(x1)} ${pdfNumber(y1)} m ${pdfNumber(x2)} ${pdfNumber(y2)} l S`,
        ].join("\n"));
    }

    circle(cx, cy, radius, options = {}) {
        const fill = options.fill || null;
        const stroke = options.stroke === undefined ? COLORS.green : options.stroke;
        const lineWidth = options.lineWidth || 1;
        const control = radius * 0.5522847498;
        let operator = "S";

        if (fill && stroke) {
            operator = "B";
        } else if (fill) {
            operator = "f";
        }

        this.add([
            fill ? rgbCommand(fill, "rg") : "",
            stroke ? rgbCommand(stroke, "RG") : "",
            `${pdfNumber(lineWidth)} w`,
            [
                `${pdfNumber(cx + radius)} ${pdfNumber(cy)} m`,
                `${pdfNumber(cx + radius)} ${pdfNumber(cy + control)} ${pdfNumber(cx + control)} ${pdfNumber(cy + radius)} ${pdfNumber(cx)} ${pdfNumber(cy + radius)} c`,
                `${pdfNumber(cx - control)} ${pdfNumber(cy + radius)} ${pdfNumber(cx - radius)} ${pdfNumber(cy + control)} ${pdfNumber(cx - radius)} ${pdfNumber(cy)} c`,
                `${pdfNumber(cx - radius)} ${pdfNumber(cy - control)} ${pdfNumber(cx - control)} ${pdfNumber(cy - radius)} ${pdfNumber(cx)} ${pdfNumber(cy - radius)} c`,
                `${pdfNumber(cx + control)} ${pdfNumber(cy - radius)} ${pdfNumber(cx + radius)} ${pdfNumber(cy - control)} ${pdfNumber(cx + radius)} ${pdfNumber(cy)} c`,
                `h ${operator}`,
            ].join("\n"),
        ].filter(Boolean).join("\n"));
    }

    text(value, x, y, options = {}) {
        this.add([
            rgbCommand(options.color || COLORS.green, "rg"),
            "BT",
            `/${options.font || "F1"} ${pdfNumber(options.size || 10)} Tf`,
            `${pdfNumber(x)} ${pdfNumber(y)} Td`,
            `${encodePdfText(value)} Tj`,
            "ET",
        ].join("\n"));
    }

    build() {
        const objects = [];
        const addObject = (body) => {
            objects.push(body);
            return objects.length;
        };

        const catalogId = addObject("");
        const pagesId = addObject("");
        const regularFontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
        const boldFontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
        const pageIds = [];

        for (const page of this.pages) {
            const content = page.join("\n") + "\n";
            const contentId = addObject(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
            const pageId = addObject([
                "<< /Type /Page",
                `/Parent ${pagesId} 0 R`,
                `/MediaBox [0 0 ${pdfNumber(this.width)} ${pdfNumber(this.height)}]`,
                `/Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >>`,
                `/Contents ${contentId} 0 R`,
                ">>",
            ].join(" "));
            pageIds.push(pageId);
        }

        objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
        objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

        let pdf = "%PDF-1.4\n% RecyTech Shop\n";
        const offsets = [0];

        objects.forEach((object, index) => {
            offsets[index + 1] = Buffer.byteLength(pdf);
            pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
        });

        const xrefOffset = Buffer.byteLength(pdf);
        pdf += `xref\n0 ${objects.length + 1}\n`;
        pdf += "0000000000 65535 f \n";
        for (let index = 1; index <= objects.length; index += 1) {
            pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
        }
        pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

        return Buffer.from(pdf);
    }
}

function formatMoney(cents, currency = "CHF") {
    return new Intl.NumberFormat("fr-CH", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
    }).format((cents || 0) / 100);
}

function formatDocumentDate(value) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.valueOf())) {
        return "";
    }

    return new Intl.DateTimeFormat("fr-CH", {
        dateStyle: "long",
    }).format(parsed);
}

function splitAddressLines(value) {
    return String(value || "")
        .split(/\r?\n|,/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function normalizeComparisonLine(value) {
    return normalizeText(value)
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ");
}

function areSameAddressLines(firstLines, secondLines) {
    const first = (firstLines || []).map(normalizeComparisonLine).filter(Boolean);
    const second = (secondLines || []).map(normalizeComparisonLine).filter(Boolean);

    return first.length > 0 &&
        first.length === second.length &&
        first.every((line, index) => line === second[index]);
}

function addDays(value, days) {
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf())) {
        return null;
    }

    date.setDate(date.getDate() + days);
    return date;
}

function getPaymentTerms(order) {
    const dueDate = addDays(order.created_at, 30);
    return dueDate ? `${PAYMENT_TERMS} (${formatDocumentDate(dueDate)})` : PAYMENT_TERMS;
}

function isLocalUrl(value) {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(?::|\/|$)/i.test(normalizeText(value));
}

function getWebsiteUrl(context) {
    const url = normalizeText(context.settings?.website_url || context.config?.websiteUrl || context.baseUrl).replace(/\/$/, "");
    return isLocalUrl(url) ? "" : url;
}

function getTermsUrl(context) {
    const configuredUrl = normalizeText(context.config?.termsUrl || context.settings?.terms_url);
    if (configuredUrl && !isLocalUrl(configuredUrl)) {
        return configuredUrl;
    }

    const websiteUrl = getWebsiteUrl(context);
    return websiteUrl ? `${websiteUrl}/conditions-generales-de-vente` : "/conditions-generales-de-vente";
}

function getPaymentMethod(context) {
    const metadata = context.order.metadata || {};
    const rawMethod = normalizeText(
        metadata.checkout?.payment_method ||
        metadata.manual?.payment_method ||
        context.order.paymentMethod ||
        context.order.payment_method ||
        context.order.provider
    ).toLowerCase();

    return rawMethod === "transfer" ? "bank_transfer" : rawMethod;
}

function isBankTransferPayment(context) {
    const method = getPaymentMethod(context);
    const manualLabel = normalizeText(context.order.metadata?.manual?.payment_label).toLowerCase();
    return BANK_TRANSFER_METHODS.has(method) || /virement|bank transfer/.test(manualLabel);
}

function splitLongWord(word, maxChars) {
    if (word.length <= maxChars) {
        return [word];
    }

    const parts = [];
    for (let index = 0; index < word.length; index += maxChars) {
        parts.push(word.slice(index, index + maxChars));
    }
    return parts;
}

function wrapText(value, maxChars) {
    const lineLimit = Math.max(4, maxChars || 24);
    const words = normalizeText(value)
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((word) => splitLongWord(word, lineLimit));
    const lines = [];
    let current = "";

    for (const word of words) {
        if (!current) {
            current = word;
            continue;
        }

        if (`${current} ${word}`.length <= lineLimit) {
            current = `${current} ${word}`;
            continue;
        }

        lines.push(current);
        current = word;
    }

    if (current) {
        lines.push(current);
    }

    return lines.length ? lines : [""];
}

function truncateText(value, maxChars) {
    const textValue = normalizeText(value);
    if (textValue.length <= maxChars) {
        return textValue;
    }

    return `${textValue.slice(0, Math.max(1, maxChars - 1))}…`;
}

function shortenMiddle(value, maxChars) {
    const textValue = normalizeText(value);
    if (textValue.length <= maxChars) {
        return textValue;
    }

    const keep = Math.max(2, maxChars - 1);
    const start = Math.ceil(keep / 2);
    const end = Math.floor(keep / 2);
    return `${textValue.slice(0, start)}…${textValue.slice(-end)}`;
}

function drawWrappedText(pdf, text, x, y, options = {}) {
    const size = options.size || 10;
    const lineHeight = options.lineHeight || size + 3;
    const maxChars = Math.max(8, Math.floor((options.maxWidth || 120) / (size * 0.48)));
    const lines = wrapText(text, maxChars).slice(0, options.maxLines || 12);

    lines.forEach((line, index) => {
        pdf.text(line, x, y - (index * lineHeight), options);
    });

    return y - (lines.length * lineHeight);
}

function drawInfoBlock(pdf, title, textLines, x, topY, width, height) {
    pdf.rect(x, topY - height, width, height, {
        fill: COLORS.surface,
        stroke: COLORS.border,
    });
    pdf.text(title, x + 18, topY - 22, {
        font: "F2",
        size: 12,
    });

    textLines.forEach((line, index) => {
        pdf.text(line, x + 18, topY - 40 - (index * 12), {
            size: 9,
            color: COLORS.muted,
        });
    });
}


function getOrderSubtotal(order) {
    return (order.items || []).reduce((total, item) => {
        const lineTotal = Number.isFinite(item.line_total_cents)
            ? item.line_total_cents
            : (item.unit_price_cents || 0) * (item.quantity || 0);
        return total + lineTotal;
    }, 0);
}

function getAdditions(order) {
    return Array.isArray(order.metadata?.additions)
        ? order.metadata.additions.filter((line) => Number.isFinite(line?.amount_cents))
        : [];
}

function getAdditionDocumentLabel(line) {
    if (line?.type === "discount") {
        return "Remise";
    }

    if (line?.type === "shipping") {
        return "Livraison";
    }

    return shortenMiddle(line?.label || "Ajustement", 16);
}

function getDocumentTitle(type) {
    return type === "delivery-slip" ? "Bon de livraison" : "Facture";
}

function getDocumentNumberPrefix(type) {
    return type === "delivery-slip" ? "BL" : "F";
}

function getFallbackStatusLabel(status) {
    const labels = {
        pending: "En attente",
        awaiting_transfer: "En attente du virement",
        paid: "Payée",
        processing: "En préparation",
        ready_for_pickup: "Prête au retrait",
        shipped: "Expédiée",
        completed: "Terminée",
        cancelled: "Annulée",
        failed: "Échouée",
        refunded: "Remboursée",
    };

    return labels[status] || status;
}

function readLogoSvg() {
    if (logoSvgCache !== null) {
        return logoSvgCache;
    }

    try {
        logoSvgCache = fs.readFileSync(LOGO_SVG_PATH, "utf8");
    } catch {
        logoSvgCache = "";
    }

    return logoSvgCache;
}

function parseSvgAttributes(source) {
    const attributes = {};
    const pattern = /([:\w-]+)="([^"]*)"/g;
    let match = pattern.exec(source);

    while (match) {
        attributes[match[1]] = match[2];
        match = pattern.exec(source);
    }

    return attributes;
}

function parseSvgNumber(value, fallback = 0) {
    const parsed = Number.parseFloat(String(value || ""));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getSvgPaint(value) {
    const color = normalizeText(value);
    return color && color !== "none" && /^#[0-9a-f]{3,8}$/i.test(color) ? color.slice(0, 7) : null;
}

function svgEllipsePath(cx, cy, rx, ry) {
    const controlX = rx * 0.5522847498;
    const controlY = ry * 0.5522847498;

    return [
        `${pdfNumber(cx + rx)} ${pdfNumber(cy)} m`,
        `${pdfNumber(cx + rx)} ${pdfNumber(cy + controlY)} ${pdfNumber(cx + controlX)} ${pdfNumber(cy + ry)} ${pdfNumber(cx)} ${pdfNumber(cy + ry)} c`,
        `${pdfNumber(cx - controlX)} ${pdfNumber(cy + ry)} ${pdfNumber(cx - rx)} ${pdfNumber(cy + controlY)} ${pdfNumber(cx - rx)} ${pdfNumber(cy)} c`,
        `${pdfNumber(cx - rx)} ${pdfNumber(cy - controlY)} ${pdfNumber(cx - controlX)} ${pdfNumber(cy - ry)} ${pdfNumber(cx)} ${pdfNumber(cy - ry)} c`,
        `${pdfNumber(cx + controlX)} ${pdfNumber(cy - ry)} ${pdfNumber(cx + rx)} ${pdfNumber(cy - controlY)} ${pdfNumber(cx + rx)} ${pdfNumber(cy)} c`,
        "h",
    ].join("\n");
}

function svgRectPath(x, y, width, height) {
    return [
        `${pdfNumber(x)} ${pdfNumber(y)} m`,
        `${pdfNumber(x + width)} ${pdfNumber(y)} l`,
        `${pdfNumber(x + width)} ${pdfNumber(y + height)} l`,
        `${pdfNumber(x)} ${pdfNumber(y + height)} l`,
        "h",
    ].join("\n");
}

function isSvgPathCommand(token) {
    return /^[a-zA-Z]$/.test(token);
}

function svgPathDataToPdfPath(data) {
    const tokens = String(data || "").match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    const commands = [];
    let index = 0;
    let command = "";
    let currentX = 0;
    let currentY = 0;
    let startX = 0;
    let startY = 0;

    const hasNumber = () => index < tokens.length && !isSvgPathCommand(tokens[index]);
    const readNumber = () => parseSvgNumber(tokens[index++]);

    while (index < tokens.length) {
        if (isSvgPathCommand(tokens[index])) {
            command = tokens[index++];
        }

        const absoluteCommand = command.toUpperCase();
        const relative = command !== absoluteCommand;

        if (absoluteCommand === "M") {
            let first = true;
            while (hasNumber()) {
                let x = readNumber();
                let y = readNumber();
                if (relative) {
                    x += currentX;
                    y += currentY;
                }
                commands.push(`${pdfNumber(x)} ${pdfNumber(y)} ${first ? "m" : "l"}`);
                currentX = x;
                currentY = y;
                if (first) {
                    startX = x;
                    startY = y;
                    first = false;
                }
            }
        } else if (absoluteCommand === "L") {
            while (hasNumber()) {
                let x = readNumber();
                let y = readNumber();
                if (relative) {
                    x += currentX;
                    y += currentY;
                }
                commands.push(`${pdfNumber(x)} ${pdfNumber(y)} l`);
                currentX = x;
                currentY = y;
            }
        } else if (absoluteCommand === "H") {
            while (hasNumber()) {
                let x = readNumber();
                if (relative) {
                    x += currentX;
                }
                commands.push(`${pdfNumber(x)} ${pdfNumber(currentY)} l`);
                currentX = x;
            }
        } else if (absoluteCommand === "V") {
            while (hasNumber()) {
                let y = readNumber();
                if (relative) {
                    y += currentY;
                }
                commands.push(`${pdfNumber(currentX)} ${pdfNumber(y)} l`);
                currentY = y;
            }
        } else if (absoluteCommand === "C") {
            while (hasNumber()) {
                let x1 = readNumber();
                let y1 = readNumber();
                let x2 = readNumber();
                let y2 = readNumber();
                let x = readNumber();
                let y = readNumber();
                if (relative) {
                    x1 += currentX;
                    y1 += currentY;
                    x2 += currentX;
                    y2 += currentY;
                    x += currentX;
                    y += currentY;
                }
                commands.push(`${pdfNumber(x1)} ${pdfNumber(y1)} ${pdfNumber(x2)} ${pdfNumber(y2)} ${pdfNumber(x)} ${pdfNumber(y)} c`);
                currentX = x;
                currentY = y;
            }
        } else if (absoluteCommand === "Z") {
            commands.push("h");
            currentX = startX;
            currentY = startY;
        } else {
            break;
        }
    }

    return commands.join("\n");
}

function svgShapeToPdfCommand(tagName, attributes) {
    const fill = getSvgPaint(attributes.fill);
    const stroke = getSvgPaint(attributes.stroke);
    if (!fill && !stroke) {
        return "";
    }

    let shapePath = "";
    if (tagName === "ellipse") {
        shapePath = svgEllipsePath(
            parseSvgNumber(attributes.cx),
            parseSvgNumber(attributes.cy),
            parseSvgNumber(attributes.rx),
            parseSvgNumber(attributes.ry)
        );
    } else if (tagName === "rect") {
        shapePath = svgRectPath(
            parseSvgNumber(attributes.x),
            parseSvgNumber(attributes.y),
            parseSvgNumber(attributes.width),
            parseSvgNumber(attributes.height)
        );
    } else if (tagName === "path") {
        shapePath = svgPathDataToPdfPath(attributes.d);
    }

    if (!shapePath) {
        return "";
    }

    return [
        stroke ? rgbCommand(stroke, "RG") : "",
        fill ? rgbCommand(fill, "rg") : "",
        stroke ? `${pdfNumber(parseSvgNumber(attributes["stroke-width"], 1))} w` : "",
        shapePath,
        fill && stroke ? "B" : fill ? "f" : "S",
    ].filter(Boolean).join("\n");
}

function buildSvgLogoCommands(svg) {
    const visibleSvg = String(svg || "").replace(/<mask[\s\S]*?<\/mask>/g, "");
    const commands = [];
    const elementPattern = /<(ellipse|rect|path)\b([^>]*)\/>/g;
    let match = elementPattern.exec(visibleSvg);

    while (match) {
        const command = svgShapeToPdfCommand(match[1], parseSvgAttributes(match[2]));
        if (command) {
            commands.push(command);
        }
        match = elementPattern.exec(visibleSvg);
    }

    return commands.join("\n");
}

function drawSvgLogo(pdf, x, y, width, height) {
    const svg = readLogoSvg();
    const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
    const logoCommands = buildSvgLogoCommands(svg);
    if (!viewBoxMatch || !logoCommands) {
        return;
    }

    const [minX, minY, viewBoxWidth, viewBoxHeight] = viewBoxMatch[1].split(/\s+/).map((value) => parseSvgNumber(value));
    const scale = Math.min(width / viewBoxWidth, height / viewBoxHeight);
    const drawWidth = viewBoxWidth * scale;
    const drawHeight = viewBoxHeight * scale;
    const offsetX = x + ((width - drawWidth) / 2);
    const offsetY = y + ((height - drawHeight) / 2);

    pdf.add([
        "q",
        `${pdfNumber(scale)} 0 0 ${pdfNumber(-scale)} ${pdfNumber(offsetX - (minX * scale))} ${pdfNumber(offsetY + drawHeight + (minY * scale))} cm`,
        logoCommands,
        "Q",
    ].join("\n"));
}

function drawHeader(pdf, context) {
    const { order, settings, type } = context;
    const documentTitle = getDocumentTitle(type);
    const documentNumber = `${getDocumentNumberPrefix(type)}-${order.order_number}`;
    const shopName = normalizeText(settings.store_name) || "RecyTech Shop";
    const shopAddressLines = splitAddressLines(settings.support_address);
    const supportEmail = normalizeText(settings.support_email);

    pdf.rect(PAGE_MARGIN, 718, 511, 78, {
        fill: COLORS.surface,
        stroke: COLORS.border,
    });
    drawSvgLogo(pdf, 50, 738, 38, 38);
    pdf.text(shopName, 94, 760, {
        font: "F2",
        size: 18,
    });
    pdf.text("Matériel reconditionné", 94, 742, {
        size: 10,
        color: COLORS.muted,
    });

    let rightY = 769;
    const headerLines = [...shopAddressLines, supportEmail, settings.support_phone, getWebsiteUrl(context)].filter(Boolean).slice(0, 5);
    for (const line of headerLines) {
        pdf.text(line, 365, rightY, {
            size: 8.5,
            color: COLORS.muted,
        });
        rightY -= 11;
    }

    pdf.text(documentTitle.toUpperCase(), PAGE_MARGIN, 672, {
        font: "F2",
        size: 30,
    });
    const metaY = drawWrappedText(pdf, documentNumber, PAGE_MARGIN, 650, {
        size: 11,
        color: COLORS.muted,
        maxWidth: 285,
        lineHeight: 12,
    }) - 6;
    const separatorY = drawDocumentMeta(pdf, context, PAGE_MARGIN, metaY, 285) - 10;
    pdf.line(PAGE_MARGIN, separatorY, 553, separatorY, {
        color: COLORS.green,
        lineWidth: 1.4,
    });

    return separatorY;
}


function drawFooter(pdf, pageNumber, context = {}) {
    const legalUrl = getTermsUrl(context);

    pdf.line(PAGE_MARGIN, 56, 553, 56, {
        color: COLORS.border,
    });
    pdf.text("Thank you for your business", PAGE_MARGIN, 46, {
        font: "F2",
        size: 8,
        color: COLORS.muted,
    });
    pdf.text(`Conditions générales de vente : ${legalUrl}`, PAGE_MARGIN, 32, {
        size: 8,
        color: COLORS.muted,
    });
    pdf.text(`Page ${pageNumber}`, 520, 32, {
        size: 8,
        color: COLORS.muted,
    });
}

function drawCompactHeader(pdf, context) {
    pdf.text(`${getDocumentTitle(context.type)} ${getDocumentNumberPrefix(context.type)}-${context.order.order_number}`, PAGE_MARGIN, 790, {
        font: "F2",
        size: 14,
    });
    pdf.line(PAGE_MARGIN, 774, 553, 774, {
        color: COLORS.green,
    });
}

function ensurePageSpace(state, neededHeight) {
    if (state.y - neededHeight >= 86) {
        return;
    }

    drawFooter(state.pdf, state.pageNumber, state.context);
    state.pdf.addPage();
    state.pageNumber += 1;
    drawCompactHeader(state.pdf, state.context);
    state.y = 742;
}

function prepareInfoBlockLines(lines, width) {
    const maxChars = Math.floor((width - 36) / (9 * 0.48));
    return lines.filter(Boolean).flatMap((line) => wrapText(line, maxChars));
}

function getInfoBlockHeight(lineCount) {
    return Math.max(76, 58 + (Math.max(1, lineCount) - 1) * 12);
}

function drawCustomerBlocks(pdf, context, topY) {
    const { contact, order, admin } = context;
    const billingLines = contact.billingLines?.length
        ? contact.billingLines
        : contact.shippingLines || [];
    const shippingLines = contact.shippingLines?.length
        ? contact.shippingLines
        : billingLines;
    const customerLines = [
        ...billingLines,
        order.customer_email,
        contact.phone,
    ].filter(Boolean);
    const delivery = order.metadata?.delivery || {};
    const fulfillmentLines = [
        delivery.label ? `Mode : ${delivery.label}` : null,
        admin?.carrier ? `Transporteur : ${admin.carrier}` : null,
        admin?.tracking_number ? `Suivi : ${admin.tracking_number}` : null,
        admin?.pickup_details ? `Retrait : ${admin.pickup_details}` : null,
    ].filter(Boolean);
    const hasDistinctShippingAddress = !areSameAddressLines(shippingLines, billingLines);
    const visibleCustomerLines = hasDistinctShippingAddress
        ? customerLines
        : [...customerLines, ...fulfillmentLines];

    if (!hasDistinctShippingAddress) {
        const customerTextLines = prepareInfoBlockLines(visibleCustomerLines.length ? visibleCustomerLines : [order.customer_name], 511);
        const height = getInfoBlockHeight(customerTextLines.length);
        drawInfoBlock(pdf, "Client", customerTextLines, PAGE_MARGIN, topY, 511, height);
        return topY - height;
    }

    const customerTextLines = prepareInfoBlockLines(customerLines.length ? customerLines : [order.customer_name], 242);
    const deliveryTextLines = prepareInfoBlockLines([...shippingLines, ...fulfillmentLines].filter(Boolean), 242);
    const height = getInfoBlockHeight(Math.max(customerTextLines.length, deliveryTextLines.length));

    drawInfoBlock(pdf, "Client", customerTextLines, PAGE_MARGIN, topY, 242, height);
    drawInfoBlock(pdf, "Livraison", deliveryTextLines, 311, topY, 242, height);

    return topY - height;
}


function drawDocumentMeta(pdf, context, x, y, maxWidth) {
    const { order, type, getOrderStatusLabel, getOrderProviderLabel } = context;
    const statusLabel = getOrderStatusLabel ? getOrderStatusLabel(order.status) : getFallbackStatusLabel(order.status);
    const providerLabel = getOrderProviderLabel ? getOrderProviderLabel(order.provider) : order.provider;
    const isInvoice = type !== "delivery-slip";
    const metaLines = [
        `${isInvoice ? "Date de facture" : "Date du bon"} : ${formatDocumentDate(order.created_at)}`,
        `Statut : ${statusLabel}`,
        isInvoice ? `Paiement : ${providerLabel}` : null,
    ].filter(Boolean);

    let currentY = y;
    for (const line of metaLines) {
        currentY = drawWrappedText(pdf, line, x, currentY, {
            size: 9,
            color: COLORS.muted,
            maxWidth,
            lineHeight: 11,
        }) - 2;
    }

    return currentY;
}


function drawTableHeader(pdf, type, y) {
    pdf.rect(PAGE_MARGIN, y - 24, 511, 26, {
        fill: COLORS.green,
        stroke: COLORS.green,
    });
    pdf.text("Article", 54, y - 15, {
        font: "F2",
        size: 9,
        color: COLORS.white,
    });
    pdf.text("Qté", type === "delivery-slip" ? 486 : 318, y - 15, {
        font: "F2",
        size: 9,
        color: COLORS.white,
    });

    if (type !== "delivery-slip") {
        pdf.text("Prix unit.", 374, y - 15, {
            font: "F2",
            size: 9,
            color: COLORS.white,
        });
        pdf.text("Total", 487, y - 15, {
            font: "F2",
            size: 9,
            color: COLORS.white,
        });
    }
}

function formatItemOptions(item) {
    return Array.isArray(item.selected_options) && item.selected_options.length
        ? item.selected_options.map((option) => `${option.name}: ${option.value}`).join(" · ")
        : "";
}

function drawItemRow(state, item, index) {
    const { pdf, context } = state;
    const isDeliverySlip = context.type === "delivery-slip";
    const optionsText = formatItemOptions(item);
    const lineTotal = Number.isFinite(item.line_total_cents)
        ? item.line_total_cents
        : (item.unit_price_cents || 0) * (item.quantity || 0);
    const productWidth = isDeliverySlip ? 330 : 245;
    const lineLimit = Math.floor(productWidth / 5.2);
    const lines = wrapText(item.name, lineLimit);

    if (optionsText) {
        lines.push(...wrapText(optionsText, lineLimit));
    }

    const rowHeight = Math.max(46, 22 + (lines.length * 12));

    ensurePageSpace(state, rowHeight + 10);

    pdf.rect(PAGE_MARGIN, state.y - rowHeight, 511, rowHeight, {
        fill: index % 2 === 0 ? COLORS.surface : COLORS.surfaceAlt,
        stroke: COLORS.border,
    });

    lines.forEach((line, lineIndex) => {
        pdf.text(line, 54, state.y - 20 - (lineIndex * 12), {
            font: lineIndex === 0 ? "F2" : "F1",
            size: 9,
            color: lineIndex === 0 ? COLORS.green : COLORS.muted,
        });
    });

    pdf.text(String(item.quantity || 0), isDeliverySlip ? 492 : 324, state.y - 20, {
        size: 9,
        color: COLORS.green,
    });

    if (!isDeliverySlip) {
        pdf.text(formatMoney(item.unit_price_cents || 0, context.order.currency), 374, state.y - 20, {
            size: 9,
            color: COLORS.green,
        });
        pdf.text(formatMoney(lineTotal, context.order.currency), 486, state.y - 20, {
            size: 9,
            color: COLORS.green,
        });
    }

    state.y -= rowHeight;
}


function drawItemsTable(state) {
    const items = Array.isArray(state.context.order.items) ? state.context.order.items : [];

    drawTableHeader(state.pdf, state.context.type, state.y);
    state.y -= 26;

    if (!items.length) {
        drawItemRow(state, {
            name: "Aucun article",
            quantity: 0,
            unit_price_cents: 0,
            line_total_cents: 0,
            selected_options: [],
        }, 0);
        return;
    }

    items.forEach((item, index) => drawItemRow(state, item, index));
}

function drawInvoiceTotals(state) {
    const { pdf, context } = state;
    const { order } = context;
    const additions = getAdditions(order);
    const rows = [
        ["Sous-total", getOrderSubtotal(order)],
        ...additions.map((line) => [getAdditionDocumentLabel(line), line.amount_cents || 0]),
        ["Total", order.amount_cents || 0],
    ];
    const paidLabel = PAID_STATUSES.has(order.status) ? "Payé" : "À payer";

    const boxHeight = 50 + (rows.length * 18);
    ensurePageSpace(state, boxHeight + 30);
    state.y -= 18;
    const topY = state.y;
    pdf.rect(332, topY - boxHeight, 221, boxHeight, {
        fill: COLORS.surface,
        stroke: COLORS.border,
    });

    let y = topY - 18;
    rows.forEach(([label, amount], index) => {
        const isTotal = index === rows.length - 1;
        pdf.text(truncateText(label, 16), 350, y, {
            font: isTotal ? "F2" : "F1",
            size: isTotal ? 12 : 10,
            color: COLORS.green,
        });
        pdf.text(formatMoney(amount, order.currency), 458, y, {
            font: isTotal ? "F2" : "F1",
            size: isTotal ? 12 : 10,
            color: COLORS.green,
        });
        y -= 18;
    });

    pdf.text(paidLabel, 350, y - 8, {
        font: "F2",
        size: 9,
        color: COLORS.muted,
    });
    state.lastTotalsBox = {
        topY,
        boxHeight,
        bottomY: topY - boxHeight,
    };
    state.y = y - 46;
}

function drawQrBillPlaceholder(pdf, x, y, size) {
    pdf.rect(x, y, size, size, {
        fill: COLORS.surfaceAlt,
        stroke: COLORS.border,
    });
    pdf.line(x + 12, y + 12, x + size - 12, y + size - 12, {
        color: COLORS.border,
    });
    pdf.line(x + size - 12, y + 12, x + 12, y + size - 12, {
        color: COLORS.border,
    });
    pdf.text("Swiss QR-bill", x + 14, y + (size / 2) + 4, {
        font: "F2",
        size: 8,
        color: COLORS.muted,
    });
    pdf.text("placeholder", x + 18, y + (size / 2) - 9, {
        size: 8,
        color: COLORS.muted,
    });
}

function drawPaymentDetails(state) {
    const { pdf, context } = state;
    const { settings } = context;
    const totalsBox = state.lastTotalsBox;
    const sideBySide = totalsBox && totalsBox.bottomY >= 116;
    const boxHeight = sideBySide ? totalsBox.boxHeight : 118;
    const boxWidth = sideBySide ? 270 : 511;
    const boxX = PAGE_MARGIN;
    const topY = sideBySide ? totalsBox.topY : state.y - 8;
    const qrSize = sideBySide ? 54 : 72;
    const qrX = boxX + boxWidth - qrSize - 18;
    const qrY = topY - boxHeight + 18;
    const iban = normalizeText(settings.bank_iban) || DEFAULT_IBAN_PLACEHOLDER;
    const accountHolder = normalizeText(settings.bank_account_holder) || normalizeText(settings.store_name) || "RecyTech";
    const bankName = normalizeText(settings.bank_name) || "Banque à définir";
    const lines = [
        `IBAN : ${iban}`,
        `Account holder name : ${accountHolder}`,
        `Bank name : ${bankName}`,
    ];

    if (!sideBySide) {
        ensurePageSpace(state, boxHeight + 18);
    }

    pdf.rect(boxX, topY - boxHeight, boxWidth, boxHeight, {
        fill: COLORS.surface,
        stroke: COLORS.border,
    });
    pdf.text("Payment details", boxX + 18, topY - 24, {
        font: "F2",
        size: 12,
    });

    lines.forEach((line, index) => {
        pdf.text(line, boxX + 18, topY - 47 - (index * 13), {
            size: 8,
            color: COLORS.muted,
        });
    });

    drawQrBillPlaceholder(pdf, qrX, qrY, qrSize);
    state.y = Math.min(state.y, topY - boxHeight) - 8;
}

function drawInvoiceCompliance(state) {
    const { pdf, context } = state;

    if (isBankTransferPayment(context)) {
        drawPaymentDetails(state);
    }

    ensurePageSpace(state, 58);
    state.y -= 10;
    pdf.text(getPaymentTerms(context.order), PAGE_MARGIN, state.y, {
        font: "F2",
        size: 10,
    });
    state.y = drawWrappedText(pdf, VAT_NOTICE, PAGE_MARGIN, state.y - 16, {
        size: 9,
        color: COLORS.muted,
        maxWidth: 500,
        lineHeight: 12,
        maxLines: 3,
    }) - 6;
}

function drawDeliveryNote(state) {
    const { pdf, context } = state;
    const note = context.admin?.fulfillment_note || context.admin?.customer_note || "";

    if (!note) {
        return;
    }

    ensurePageSpace(state, 72);
    state.y -= 22;
    pdf.text("Note de livraison", PAGE_MARGIN, state.y, {
        font: "F2",
        size: 12,
    });
    state.y = drawWrappedText(pdf, note, PAGE_MARGIN, state.y - 18, {
        size: 9,
        color: COLORS.muted,
        maxWidth: 500,
        lineHeight: 12,
        maxLines: 6,
    });
}

function drawSignatureBlock(state) {
    const { pdf } = state;
    ensurePageSpace(state, 80);
    state.y -= 28;
    pdf.text("Remis / reçu par", PAGE_MARGIN, state.y, {
        font: "F2",
        size: 10,
    });
    pdf.line(PAGE_MARGIN, state.y - 36, 260, state.y - 36, {
        color: COLORS.border,
    });
    pdf.text("Signature", PAGE_MARGIN, state.y - 52, {
        size: 8,
        color: COLORS.muted,
    });
}

function buildOrderDocumentPdf(options) {
    const context = {
        type: options.type === "delivery-slip" ? "delivery-slip" : "invoice",
        order: options.order,
        settings: options.settings || {},
        contact: options.contact || {},
        admin: options.admin || {},
        getOrderStatusLabel: options.getOrderStatusLabel,
        getOrderProviderLabel: options.getOrderProviderLabel,
        baseUrl: options.baseUrl || "",
        config: options.config || {},
    };
    const pdf = new PdfDocument();
    const state = {
        pdf,
        context,
        pageNumber: 1,
        y: 0,
    };

    const separatorY = drawHeader(pdf, context);
    const customerBlocksBottomY = drawCustomerBlocks(pdf, context, separatorY - 24);

    state.y = customerBlocksBottomY - 28;
    drawItemsTable(state);

    if (context.type === "delivery-slip") {
        drawDeliveryNote(state);
        drawSignatureBlock(state);
    } else {
        drawInvoiceTotals(state);
        drawInvoiceCompliance(state);
    }

    drawFooter(pdf, state.pageNumber, context);

    return pdf.build();
}

function buildOrderDocumentFilename(order, type) {
    const prefix = getDocumentNumberPrefix(type);
    const orderNumber = normalizeText(order?.order_number).replace(/[^a-z0-9_-]/gi, "-") || "commande";
    return `${prefix}-${orderNumber}.pdf`;
}

module.exports = {
    buildOrderDocumentPdf,
    buildOrderDocumentFilename,
};
