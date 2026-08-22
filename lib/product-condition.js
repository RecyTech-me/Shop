function normalizeFactKey(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLocaleLowerCase("fr-CH");
}

const CONDITION_KEYS = new Set(["etat", "etat esthetique", "condition", "condition esthetique"]);
const CONDITION_NOTE_KEYS = new Set(["defauts esthetiques", "details etat", "remarques etat"]);
const BATTERY_KEYS = new Set(["batterie", "etat batterie", "sante batterie", "autonomie batterie"]);

function conditionDescription(value) {
    const key = normalizeFactKey(value);

    if (["parfait", "excellent", "excellente", "comme neuf"].includes(key)) {
        return "Aspect très soigné, avec tout au plus de légères traces d’usage.";
    }
    if (["tres bon", "tres bonne"].includes(key)) {
        return "Très bon aspect général, avec de légères traces d’usage possibles.";
    }
    if (["bon", "bonne"].includes(key)) {
        return "Traces d’usage visibles compatibles avec un appareil reconditionné.";
    }
    if (["acceptable", "correct", "correcte", "moyen", "moyenne"].includes(key)) {
        return "Marques d’usage plus prononcées ; consultez attentivement les photos.";
    }

    return "Évaluation esthétique renseignée par RecyTech ; consultez les photos pour le détail.";
}

function findFact(rows, acceptedKeys) {
    return rows.find((row) => acceptedKeys.has(normalizeFactKey(row.label))) || null;
}

function findOptionGroup(groups, acceptedKeys) {
    return groups.find((group) => acceptedKeys.has(normalizeFactKey(group.name))) || null;
}

function createProductConditionReport(product) {
    const infoRows = Array.isArray(product?.info_rows) ? product.info_rows : [];
    const optionGroups = Array.isArray(product?.option_groups) ? product.option_groups : [];
    const conditionFact = findFact(infoRows, CONDITION_KEYS);
    const conditionNotes = findFact(infoRows, CONDITION_NOTE_KEYS);
    const batteryFact = findFact(infoRows, BATTERY_KEYS);
    const conditionGroup = findOptionGroup(optionGroups, CONDITION_KEYS);
    const batteryGroup = findOptionGroup(optionGroups, BATTERY_KEYS);
    const excludedKeys = new Set([...CONDITION_KEYS, ...CONDITION_NOTE_KEYS, ...BATTERY_KEYS]);
    const conditionValues = conditionGroup?.values || [];

    return {
        condition: {
            value: conditionGroup ? "À choisir" : conditionFact?.value || "Non renseigné",
            description: conditionGroup
                ? "Choisissez l’état esthétique disponible pour cette unité."
                : conditionFact
                    ? conditionDescription(conditionFact.value)
                    : "Contactez RecyTech pour obtenir le détail de l’état esthétique.",
            groupName: conditionGroup?.name || "",
            descriptions: Object.fromEntries(conditionValues.map((value) => [value, conditionDescription(value)])),
            notes: conditionNotes?.value || "",
        },
        battery: batteryFact || batteryGroup
            ? {
                value: batteryGroup ? "À choisir" : batteryFact.value,
                groupName: batteryGroup?.name || "",
            }
            : null,
        publicInfoRows: infoRows.filter((row) => !excludedKeys.has(normalizeFactKey(row.label))),
    };
}

module.exports = { conditionDescription, createProductConditionReport, normalizeFactKey };
