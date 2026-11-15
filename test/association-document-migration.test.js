const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { migrateDocuments } = require("../scripts/migrate-association-documents");
const { GROUPS } = require("../lib/association-document-manifest");

test("private storage migration verifies all files and is safe to repeat", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-doc-migration-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    assert.equal(migrateDocuments(source, destination), 0);
    assert.throws(() => migrateDocuments(source, destination, true), /Missing private document/);
    for (const [group, { documents }] of Object.entries(GROUPS)) {
        fs.mkdirSync(path.join(source, group), { recursive: true });
        for (const [filename] of documents) fs.writeFileSync(path.join(source, group, filename), "%PDF-1.4 synthetic fixture");
    }
    assert.equal(migrateDocuments(source, destination, true), 5);
    assert.equal(migrateDocuments(source, destination, true), 5);
    const target = path.join(destination, "general-meeting", "pv-ag-constitutive.pdf");
    fs.writeFileSync(target, "existing changed document");
    assert.throws(() => migrateDocuments(source, destination, true), /Conflicting document migration/);
    assert.equal(fs.readFileSync(target, "utf8"), "existing changed document");
    fs.rmSync(source, { recursive: true });
    assert.equal(migrateDocuments(source, destination, true), 5);
});
