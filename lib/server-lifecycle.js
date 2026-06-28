const logger = require("./logger");

function stopRuntime(appInstance) {
    try {
        appInstance.locals.runtime?.stop?.();
    } catch (error) {
        logger.error(`[server] Runtime shutdown failed: ${error.message}`);
    }
}

function createGracefulShutdown({ server, app, exit = process.exit, timeoutMs = 10_000 }) {
    let shuttingDown = false;

    return function gracefulShutdown(signal) {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        logger.info(`[server] Received ${signal}; shutting down`);
        const forceExitTimer = setTimeout(() => {
            logger.error("[server] Graceful shutdown timed out");
            exit(1);
        }, timeoutMs);
        forceExitTimer.unref?.();

        server.close((error) => {
            clearTimeout(forceExitTimer);
            if (error) {
                logger.error(`[server] HTTP server close failed: ${error.message}`);
                stopRuntime(app);
                exit(1);
                return;
            }

            stopRuntime(app);
            exit(0);
        });
    };
}

module.exports = {
    createGracefulShutdown,
    stopRuntime,
};
