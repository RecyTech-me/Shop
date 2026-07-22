const { DEFAULT_SETTINGS } = require("../db/schema");

function getSettings(db) {
    const rows = db.prepare("SELECT key, value FROM settings").all();
    return rows.reduce((accumulator, row) => {
        accumulator[row.key] = row.value;
        return accumulator;
    }, { ...DEFAULT_SETTINGS });
}

function saveSettings(db, values) {
    const upsert = db.prepare(`
        INSERT INTO settings (key, value)
        VALUES (@key, @value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    const transaction = db.transaction((entries) => {
        for (const [key, value] of Object.entries(entries)) {
            upsert.run({ key, value });
        }
    });

    transaction(values);
}

module.exports = {
    getSettings,
    saveSettings,
};
