const crypto = require("crypto");

const SCRYPT_KEY_LENGTH = 64;

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");
    return `${salt}:${derivedKey}`;
}

function verifyPassword(password, storedHash) {
    if (!storedHash || !storedHash.includes(":")) {
        return false;
    }

    const [salt, expectedHash] = storedHash.split(":");
    const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH);
    const expectedBuffer = Buffer.from(expectedHash, "hex");

    if (derivedKey.length !== expectedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(derivedKey, expectedBuffer);
}

module.exports = {
    hashPassword,
    verifyPassword,
};
