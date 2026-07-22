function createSettingsCache({ db, getSettings, saveSettings }) {
    let settingsCache = null;

    function getCachedSettings() {
        if (!settingsCache) {
            settingsCache = getSettings(db);
        }

        return settingsCache;
    }

    function saveCachedSettings(_db, values) {
        saveSettings(db, values);
        settingsCache = null;
    }

    return {
        getCachedSettings,
        saveCachedSettings,
    };
}

module.exports = { createSettingsCache };
