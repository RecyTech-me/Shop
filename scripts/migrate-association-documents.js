const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { GROUPS } = require("../lib/association-document-manifest");

function digest(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function migrateDocuments(sourceDir, destinationDir, requireComplete = false) {
    let verified = 0;
    for (const [group, { documents }] of Object.entries(GROUPS)) {
        for (const [filename] of documents) {
            const source = path.join(sourceDir, group, filename);
            const destination = path.join(destinationDir, group, filename);
            if (fs.existsSync(source)) {
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                if (fs.existsSync(destination)) {
                    if (digest(source) !== digest(destination)) {
                        throw new Error(`Conflicting document migration: ${group}/${filename}`);
                    }
                } else {
                    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
                }
                if (digest(source) !== digest(destination)) throw new Error("Document verification failed");
            }
            if (fs.existsSync(destination) && fs.statSync(destination).size > 0) verified++;
            else if (requireComplete) throw new Error(`Missing private document: ${group}/${filename}`);
        }
    }
    return verified;
}

if (require.main === module) {
    const [source, destination, service] = process.argv.slice(2);
    if (!source || !destination) throw new Error("Source and destination directories are required");
    console.log(`Private document storage: ${migrateDocuments(source, destination, service === "shopsite")} verified files`);
}

module.exports = { migrateDocuments };
