const path = require("node:path");

const PREFIX = "/association-documents";
const { GROUPS } = require("../lib/association-document-manifest");

// Only known document destinations can survive session regeneration at login.
function getDocumentReturnTarget(value) {
    if (typeof value !== "string") return null;
    let decoded;
    try {
        decoded = decodeURIComponent(value);
    } catch (_error) {
        return null;
    }
    for (const [group, { documents }] of Object.entries(GROUPS)) {
        const base = `${PREFIX}/${group}`;
        if (decoded === base) return base;
        for (const [filename] of documents) {
            if (decoded === `${base}/${filename}`) {
                return `${base}/${encodeURIComponent(filename)}`;
            }
        }
    }
    return null;
}

function registerAssociationDocumentRoutes({ app, http, documentsDir }) {
    const { requireAdmin, saveSessionAndRedirect } = http;
    app.use(PREFIX, (req, res, next) => {
        res.set("Cache-Control", "private, no-store");
        res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
        if (!req.currentAdmin) {
            req.session.documentsReturnTo = getDocumentReturnTarget(req.originalUrl) || `${PREFIX}/committee`;
            return saveSessionAndRedirect(req, res, "/admin/login");
        }
        return next();
    }, requireAdmin);

    for (const [group, { title, documents }] of Object.entries(GROUPS)) {
        app.get(`${PREFIX}/${group}`, (req, res) => {
            res.render("association-documents", {
                title,
                documents: documents.map(([filename, label]) => ({
                    label,
                    href: `${PREFIX}/${group}/${encodeURIComponent(filename)}`,
                })),
            });
        });
        app.get(`${PREFIX}/${group}/:filename`, (req, res, next) => {
            const document = documents.find(([filename]) => filename === req.params.filename);
            if (!document) {
                return res.status(404).render("not-found", { title: "Document introuvable" });
            }
            const file = path.join(documentsDir, group, document[0]);
            res.sendFile(file, { cacheControl: false, acceptRanges: false, dotfiles: "deny" }, (error) => {
                if (error) next(error);
            });
        });
    }
}

module.exports = { registerAssociationDocumentRoutes, getDocumentReturnTarget };
