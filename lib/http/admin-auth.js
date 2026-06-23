function createAdminAuth({ db, getAdminById, setFlash, saveSessionAndRedirect }) {
    function requireAdmin(req, res, next) {
        const currentAdmin = req.currentAdmin || (req.session.adminId ? getAdminById(db, req.session.adminId) : null);
        if (!currentAdmin) {
            req.session.adminId = null;
            return res.redirect("/admin/login");
        }

        req.currentAdmin = currentAdmin;
        res.locals.currentAdmin = currentAdmin;
        next();
    }

    function requireSuperadmin(req, res, next) {
        const currentAdmin = req.currentAdmin || (req.session.adminId ? getAdminById(db, req.session.adminId) : null);
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

module.exports = { createAdminAuth };
