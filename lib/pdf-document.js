const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 42;

const COLORS = {
    background: "#ffffff",
    surface: "#fffdf8",
    surfaceAlt: "#f8f3ea",
    green: "#1f4b35",
    muted: "#5f7468",
    border: "#d8d0c1",
    white: "#ffffff",
};

const WIN_ANSI_EXTRA_CHARS = new Map([
    ["\u2018", 0x91],
    ["\u2019", 0x92],
    ["\u201C", 0x93],
    ["\u201D", 0x94],
    ["\u2013", 0x96],
    ["\u2014", 0x97],
    ["\u2026", 0x85],
]);

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

module.exports = {
    COLORS,
    PAGE_MARGIN,
    PdfDocument,
    pdfNumber,
    rgbCommand,
};
