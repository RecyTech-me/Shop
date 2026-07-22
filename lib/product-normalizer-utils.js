function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
}

function parseLineList(value) {
    return String(value || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function parseLinesWithNumbers(value) {
    return String(value || "")
        .split(/\r?\n/)
        .map((line, index) => ({
            line: line.trim(),
            lineNumber: index + 1,
        }))
        .filter((entry) => entry.line);
}

function parseCategoryList(value) {
    return uniqueStrings(
        String(value || "")
            .split(/[\r\n,]+/)
            .map((item) => item.trim())
            .filter(Boolean)
    );
}

function parseCategoryListStrict(value) {
    const categories = [];

    for (const { line, lineNumber } of parseLinesWithNumbers(value)) {
        const parts = line.split(",");

        if (parts.some((part) => !part.trim())) {
            throw new Error(`Ligne ${lineNumber} des catégories : catégorie vide ou virgule mal placée.`);
        }

        categories.push(...parts.map((part) => part.trim()));
    }

    return uniqueStrings(categories);
}

function formatCategoryList(categories) {
    return (categories || []).join("\n");
}

function parseInfoRows(value) {
    return parseLineList(value)
        .map((line) => {
            const separatorIndex = line.indexOf(":");
            if (separatorIndex === -1) {
                return null;
            }

            const label = line.slice(0, separatorIndex).trim();
            const valueText = line.slice(separatorIndex + 1).trim();

            if (!label || !valueText) {
                return null;
            }

            return { label, value: valueText };
        })
        .filter(Boolean);
}

module.exports = {
    formatCategoryList,
    parseCategoryList,
    parseCategoryListStrict,
    parseInfoRows,
    parseJsonArray,
    parseLineList,
    parseLinesWithNumbers,
    uniqueStrings,
};
