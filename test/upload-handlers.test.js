const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
    detectStoredImageFormat,
    validateStoredImageUploads,
} = require("../lib/upload-handlers");

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("stored image validation verifies both file signature and declared type", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-upload-test-"));
    const validPath = path.join(directory, "valid.png");
    const mismatchPath = path.join(directory, "mismatch.jpg");
    fs.writeFileSync(validPath, PNG_HEADER);
    fs.writeFileSync(mismatchPath, PNG_HEADER);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    assert.equal(detectStoredImageFormat(validPath), "png");
    assert.doesNotThrow(() => validateStoredImageUploads([{ path: validPath, mimetype: "image/png" }]));
    assert.throws(
        () => validateStoredImageUploads([{ path: mismatchPath, mimetype: "image/jpeg" }]),
        /invalides ou corrompues/
    );
    assert.equal(fs.existsSync(mismatchPath), false);
});
