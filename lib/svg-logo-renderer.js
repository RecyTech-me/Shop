const fs = require("fs");
const path = require("path");
const {
    pdfNumber,
    rgbCommand,
} = require("./pdf-document");

const LOGO_SVG_PATH = path.join(__dirname, "..", "public", "images", "recytech-logo.svg");

let logoSvgCache = null;

function normalizeSvgText(value) {
    return String(value || "").trim();
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
    const color = normalizeSvgText(value);
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

module.exports = {
    drawSvgLogo,
};
