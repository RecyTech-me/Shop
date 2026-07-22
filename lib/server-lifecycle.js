const logger = require("./logger");

async function stopRuntime(appInstance) {
    try {
        await appInstance.locals.runtime?.stop?.();
        return true;
    } catch (error) {
        logger.error(`[server] Runtime shutdown failed: ${error.message}`);
        return false;
    }
}

function createGracefulShutdown({ server, app, exit = process.exit, timeoutMs = 10_000 }) {
    let shuttingDown = false;
    let shutdownPromise = null;

    return function gracefulShutdown(signal) {
        if (shuttingDown) {
            return shutdownPromise;
        }

        shuttingDown = true;
        logger.info(`[server] Received ${signal}; shutting down`);
        shutdownPromise = new Promise((resolve) => {
            const forceExitTimer = setTimeout(() => {
                logger.error("[server] Graceful shutdown timed out");
                exit(1);
            }, timeoutMs);
            forceExitTimer.unref?.();

            server.close(async (error) => {
                if (error) {
                    logger.error(`[server] HTTP server close failed: ${error.message}`);
                }

                const runtimeStopped = await stopRuntime(app);
                clearTimeout(forceExitTimer);
                const exitCode = error || !runtimeStopped ? 1 : 0;
                exit(exitCode);
                resolve(exitCode);
            });
        });

        return shutdownPromise;
    };
}

module.exports = {
    createGracefulShutdown,
    stopRuntime,
};
