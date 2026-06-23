const { verifyPassword } = require("../../lib/auth");
const { ADMIN_ROLE_OPTIONS } = require("../../lib/shop-formatters");

function registerAdminSessionRoutes(deps) {
    const {
        app,
        db,
        requireAdmin,
        requireSuperadmin,
        render,
        setFlash,
        saveSessionAndRedirect,
        readAdminUserInput,
        readAdminAccountInput,
        getLoginRateLimitState,
        registerLoginFailure,
        clearLoginFailures,
        getOrCreateCsrfToken,
        getAdminByUsername,
        getAdminById,
        listAdmins,
        countAdminsByRole,
        createAdminUser,
        updateAdminUser,
        deleteAdminUser,
    } = deps;

    app.get("/admin/login", (req, res) => {
        if (req.session.adminId) {
            return res.redirect("/");
        }

        render(res, "admin/login", {
            title: "Connexion",
        });
    });

    app.post("/admin/login", (req, res) => {
        const rateLimitState = getLoginRateLimitState(req);
        if (rateLimitState.blockedUntil > Date.now()) {
            setFlash(req, "error", "Trop de tentatives de connexion. Réessayez plus tard.");
            return saveSessionAndRedirect(req, res, "/admin/login");
        }

        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");
        const admin = getAdminByUsername(db, username);

        if (!admin || !verifyPassword(password, admin.password_hash)) {
            registerLoginFailure(req);
            setFlash(req, "error", "Identifiants invalides.");
            return saveSessionAndRedirect(req, res, "/admin/login");
        }

        clearLoginFailures(req);
        req.session.regenerate((error) => {
            if (error) {
                setFlash(req, "error", "Impossible d'ouvrir une session sécurisée.");
                return saveSessionAndRedirect(req, res, "/admin/login");
            }

            req.session.adminId = admin.id;
            getOrCreateCsrfToken(req);
            setFlash(req, "success", "Connexion réussie.");
            return saveSessionAndRedirect(req, res, "/");
        });
    });

    app.post("/admin/logout", requireAdmin, (req, res) => {
        req.session.destroy(() => {
            res.clearCookie("connect.sid");
            res.redirect("/admin/login");
        });
    });

    app.get("/admin/account", requireAdmin, (req, res) => {
        render(res, "admin/account", {
            title: "Mon compte",
        });
    });

    app.post("/admin/account", requireAdmin, (req, res) => {
        const adminRecord = getAdminByUsername(db, req.currentAdmin.username);
        if (!adminRecord) {
            req.session.adminId = null;
            setFlash(req, "error", "Session administrateur invalide.");
            return saveSessionAndRedirect(req, res, "/admin/login");
        }

        try {
            const input = readAdminAccountInput(req.body, adminRecord);

            if ((input.usernameChanged || input.passwordChanged) && !verifyPassword(input.currentPassword, adminRecord.password_hash)) {
                throw new Error("Le mot de passe actuel est incorrect.");
            }

            updateAdminUser(db, adminRecord.id, {
                username: input.username,
                role: adminRecord.role,
                password: input.password,
            });

            setFlash(req, "success", "Votre compte a été mis à jour.");
            return saveSessionAndRedirect(req, res, "/admin/account");
        } catch (error) {
            const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
                ? "Ce nom d'utilisateur existe déjà."
                : error.message;
            setFlash(req, "error", message);
            return saveSessionAndRedirect(req, res, "/admin/account");
        }
    });

    app.get("/admin/admins", requireSuperadmin, (req, res) => {
        render(res, "admin/admins", {
            title: "Administrateurs",
            admins: listAdmins(db),
            superadminCount: countAdminsByRole(db, "superadmin"),
        });
    });

    app.get("/admin/admins/new", requireSuperadmin, (req, res) => {
        render(res, "admin/admin-form", {
            title: "Nouvel administrateur",
            formAction: "/admin/admins/new",
            adminUser: null,
            roleOptions: ADMIN_ROLE_OPTIONS,
            currentAdminId: req.currentAdmin.id,
        });
    });

    app.post("/admin/admins/new", requireSuperadmin, (req, res) => {
        try {
            const input = readAdminUserInput(req.body, { requirePassword: true });
            createAdminUser(db, input);
            setFlash(req, "success", "Administrateur créé.");
            return saveSessionAndRedirect(req, res, "/admin/admins");
        } catch (error) {
            const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
                ? "Ce nom d'utilisateur existe déjà."
                : error.message;
            setFlash(req, "error", message);
            return saveSessionAndRedirect(req, res, "/admin/admins/new");
        }
    });

    app.get("/admin/admins/:id/edit", requireSuperadmin, (req, res) => {
        const adminUser = getAdminById(db, Number.parseInt(req.params.id, 10));
        if (!adminUser) {
            return res.status(404).render("not-found", { title: "Administrateur introuvable" });
        }

        render(res, "admin/admin-form", {
            title: `Modifier ${adminUser.username}`,
            formAction: `/admin/admins/${adminUser.id}/edit`,
            adminUser,
            roleOptions: ADMIN_ROLE_OPTIONS,
            currentAdminId: req.currentAdmin.id,
        });
    });

    app.post("/admin/admins/:id/edit", requireSuperadmin, (req, res) => {
        const adminId = Number.parseInt(req.params.id, 10);
        const existingAdmin = getAdminById(db, adminId);
        if (!existingAdmin) {
            return res.status(404).render("not-found", { title: "Administrateur introuvable" });
        }

        try {
            const input = readAdminUserInput(req.body);
            if (existingAdmin.role === "superadmin" && input.role !== "superadmin" && countAdminsByRole(db, "superadmin") <= 1) {
                throw new Error("Le dernier superadmin ne peut pas être rétrogradé.");
            }

            updateAdminUser(db, adminId, input);
            setFlash(req, "success", "Administrateur mis à jour.");
            return saveSessionAndRedirect(req, res, "/admin/admins");
        } catch (error) {
            const message = error.code === "SQLITE_CONSTRAINT_UNIQUE"
                ? "Ce nom d'utilisateur existe déjà."
                : error.message;
            setFlash(req, "error", message);
            return saveSessionAndRedirect(req, res, `/admin/admins/${adminId}/edit`);
        }
    });

    app.post("/admin/admins/:id/delete", requireSuperadmin, (req, res) => {
        const adminId = Number.parseInt(req.params.id, 10);
        const adminUser = getAdminById(db, adminId);
        if (!adminUser) {
            return res.status(404).render("not-found", { title: "Administrateur introuvable" });
        }

        if (adminUser.id === req.currentAdmin.id) {
            setFlash(req, "error", "Vous ne pouvez pas supprimer votre propre compte.");
            return saveSessionAndRedirect(req, res, "/admin/admins");
        }

        if (adminUser.role === "superadmin" && countAdminsByRole(db, "superadmin") <= 1) {
            setFlash(req, "error", "Le dernier superadmin ne peut pas être supprimé.");
            return saveSessionAndRedirect(req, res, "/admin/admins");
        }

        deleteAdminUser(db, adminId);
        setFlash(req, "success", "Administrateur supprimé.");
        return saveSessionAndRedirect(req, res, "/admin/admins");
    });
}

module.exports = { registerAdminSessionRoutes };
