require("dotenv").config({
    path: require("path").join(__dirname, ".env"),
    quiet: true,
});

const { createApp } = require("./app");
const logger = require("./lib/logger");
const { createGracefulShutdown } = require("./lib/server-lifecycle");

const env = process.env;
const port = Number.parseInt(env.PORT || "3000", 10);
const host = env.HOST || "127.0.0.1";
const app = createApp();
let server = null;

function startServer({ app: appInstance = app, listenPort = port, listenHost = host } = {}) {
    const activeServer = appInstance.listen(listenPort, listenHost, () => {
        logger.info(`RecyTech shop listening on http://${listenHost}:${listenPort}`);
    });

    return activeServer;
}

if (require.main === module) {
    server = startServer();
    const shutdown = createGracefulShutdown({ server, app });
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
}

module.exports = {
    app,
    createApp,
    createGracefulShutdown,
    startServer,
};
