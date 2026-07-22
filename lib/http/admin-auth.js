function getAuthenticatedAdmin(req, db, getAdminById) {
    if (!req.session.adminId) {
        return null;
    }

    const currentAdmin = getAdminById(db, req.session.adminId);
    const sessionAuthVersion = Number.parseInt(req.session.adminAuthVersion, 10);
    if (!currentAdmin || !Number.isInteger(sessionAuthVersion) || sessionAuthVersion !== currentAdmin.auth_version) {
        delete req.session.adminId;
        delete req.session.adminAuthVersion;
        return null;
    }

    return currentAdmin;
}

function createAdminAuth({ db, getAdminById, setFlash, saveSessionAndRedirect }) {
    function requireAdmin(req, res, next) {
        const currentAdmin = req.currentAdmin || getAuthenticatedAdmin(req, db, getAdminById);
        if (!currentAdmin) {
            req.session.adminId = null;
            return res.redirect("/admin/login");
        }

        req.currentAdmin = currentAdmin;
        res.locals.currentAdmin = currentAdmin;
        next();
    }

    function requireSuperadmin(req, res, next) {
        const currentAdmin = req.currentAdmin || getAuthenticatedAdmin(req, db, getAdminById);
        if (!currentAdmin) {
            req.session.adminId = null;
            return res.redirect("/admin/login");
        }

        if (currentAdmin.role !== "superadmin") {
            setFlash(req, "error", "Accès réservé aux superadmins.");
            return saveSessionAndRedirect(req, res, "/admin");
        }

        req.currentAdmin = currentAdmin;
        res.locals.currentAdmin = currentAdmin;
        next();
    }

    return {
        requireAdmin,
        requireSuperadmin,
    };
}

module.exports = { createAdminAuth, getAuthenticatedAdmin };
