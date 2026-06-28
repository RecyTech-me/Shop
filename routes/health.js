function registerHealthRoutes({ app, db }) {
    app.get("/healthz", (req, res) => {
        db.prepare("SELECT 1 AS ok").get();
        res.set("Cache-Control", "no-store");
        res.json({
            status: "ok",
            checks: {
                database: "ok",
            },
            uptime_seconds: Math.floor(process.uptime()),
        });
    });
}

module.exports = { registerHealthRoutes };
