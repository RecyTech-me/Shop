function write(level, values) {
    const target = level === "error"
        ? console.error
        : level === "warn"
            ? console.warn
            : console.log;
    const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;

    target(prefix, ...values);
}

function info(...values) {
    write("info", values);
}

function warn(...values) {
    write("warn", values);
}

function error(...values) {
    write("error", values);
}

module.exports = {
    error,
    info,
    warn,
};
