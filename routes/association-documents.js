const path = require("node:path");

const PREFIX = "/association-documents";
const GROUPS = {
    committee: {
        title: "Documents du comité",
        documents: [
            ["pv-comité-04.04.2025.pdf", "Procès-verbal du comité du 4 avril 2025"],
            ["pv-comité-02.05.2025.pdf", "Procès-verbal du comité du 2 mai 2025"],
            ["pv-comité-05.12.2025.pdf", "Procès-verbal du comité du 5 décembre 2025"],
            ["pv-comité-09.05.2026.pdf", "Procès-verbal du comité du 9 mai 2026"],
        ],
    },
    "general-meeting": {
        title: "Documents des assemblées générales",
        documents: [["pv-ag-constitutive.pdf", "Procès-verbal de l’assemblée générale constitutive"]],
    },
};

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

function registerAssociationDocumentRoutes({ app, http }) {
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
            const file = path.join(__dirname, "..", "private", "association-documents", group, document[0]);
            res.sendFile(file, { cacheControl: false, acceptRanges: false, dotfiles: "deny" }, (error) => {
                if (error) next(error);
            });
        });
    }
}

module.exports = { registerAssociationDocumentRoutes, getDocumentReturnTarget };
