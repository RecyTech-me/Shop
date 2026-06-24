require("dotenv").config({
    path: require("path").join(__dirname, ".env"),
    quiet: true,
});

const { createApp } = require("./app");
const logger = require("./lib/logger");

const env = process.env;
const port = Number.parseInt(env.PORT || "3000", 10);
const host = env.HOST || "127.0.0.1";
const app = createApp();

if (require.main === module) {
    app.listen(port, host, () => {
        logger.info(`RecyTech shop listening on http://${host}:${port}`);
    });
}

module.exports = { app, createApp };
