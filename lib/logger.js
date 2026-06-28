const LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100,
};

const loggerState = {
    format: "text",
    level: "info",
};

function normalizeLevel(value) {
    const level = String(value || "").trim().toLowerCase();
    return Object.hasOwn(LEVELS, level) ? level : "info";
}

function normalizeFormat(value) {
    return String(value || "").trim().toLowerCase() === "json" ? "json" : "text";
}

function configureLogger(options = {}) {
    loggerState.level = normalizeLevel(options.level);
    loggerState.format = normalizeFormat(options.format);
}

function shouldWrite(level) {
    return LEVELS[level] >= LEVELS[loggerState.level] && loggerState.level !== "silent";
}

function serializeError(errorValue) {
    return {
        name: errorValue.name,
        message: errorValue.message,
        stack: errorValue.stack,
    };
}

function serializeValue(value) {
    if (value instanceof Error) {
        return serializeError(value);
    }

    return value;
}

function normalizeEntry(level, values) {
    const [firstValue, secondValue, ...remainingValues] = values;
    const message = typeof firstValue === "string" ? firstValue : "";
    const metadata = message ? secondValue : firstValue;
    const extra = message ? remainingValues : [secondValue, ...remainingValues].filter((value) => value !== undefined);

    return {
        timestamp: new Date().toISOString(),
        level,
        message,
        metadata: metadata && typeof metadata === "object" && !(metadata instanceof Error)
            ? serializeValue(metadata)
            : undefined,
        error: metadata instanceof Error ? serializeError(metadata) : undefined,
        extra: extra.map(serializeValue),
    };
}

function writeJson(level, values, target) {
    const entry = normalizeEntry(level, values);
    target(JSON.stringify(Object.fromEntries(
        Object.entries(entry).filter(([, value]) => {
            if (Array.isArray(value)) {
                return value.length > 0;
            }

            return value !== undefined && value !== "";
        })
    )));
}

function writeText(level, values, target) {
    const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
    target(prefix, ...values);
}

function write(level, values) {
    if (!shouldWrite(level)) {
        return;
    }

    const target = level === "error"
        ? console.error
        : level === "warn"
            ? console.warn
            : console.log;

    if (loggerState.format === "json") {
        writeJson(level, values, target);
        return;
    }

    writeText(level, values, target);
}

function debug(...values) {
    write("debug", values);
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
    configureLogger,
    debug,
    error,
    info,
    warn,
};
