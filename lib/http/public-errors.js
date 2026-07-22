const INTERNAL_ERROR_NAMES = new Set([
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
]);

function isInternalPublicError(error) {
    const code = String(error?.code || "");
    return code.startsWith("SQLITE_") || INTERNAL_ERROR_NAMES.has(error?.name);
}

function getPublicErrorResponse(error, fallbackMessage) {
    if (!isInternalPublicError(error)) {
        return {
            internal: false,
            message: String(error?.message || fallbackMessage),
            statusCode: 400,
        };
    }

    const code = String(error?.code || "");
    const temporarilyUnavailable = code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
    return {
        internal: true,
        message: fallbackMessage,
        statusCode: temporarilyUnavailable ? 503 : 500,
    };
}

module.exports = { getPublicErrorResponse, isInternalPublicError };
