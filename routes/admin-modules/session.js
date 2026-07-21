const { verifyPassword, verifyPasswordAsync } = require("../../lib/auth");
const { parseInteger } = require("../../lib/input-utils");
const logger = require("../../lib/logger");
const { ADMIN_ROLE_OPTIONS } = require("../../lib/shop-formatters");

const INVALID_LOGIN_PASSWORD_HASH = "00000000000000000000000000000000:abfdd81bf7129c0eb2d1a12469d84d24639044a94ce15e6b8fa230aaed3949eaca1910f40f5f90e40ce744bd47bcfd7ef54b3cc73cb2c6a91138b11e84b2d69c";

function registerAdminSessionRoutes(deps) {
    const {
        app,
        db,
        http,
        forms,
        admins,
    } = deps;
    const {
        requireAdmin,
        requireSuperadmin,
        render,
        setFlash,
        saveSessionAndRedirect,
        getLoginRateLimitState,
        registerLoginAttempt,
        clearLoginAttempts,
        getOrCreateCsrfToken,
    } = http;
    const { readAdminUserInput, readAdminAccountInput } = forms;
    const {
        getAdminByUsername,
        getAdminById,
        listAdmins,
        countAdminsByRole,
        createAdminUser,
        updateAdminUser,
        deleteAdminUser,
    } = admins;

    app.get("/admin/login", (req, res) => {
        if (req.session.adminId) {
            return res.redirect("/");
        }

        render(res, "admin/login", {
            title: "Connexion",
        });
    });

    app.post("/admin/login", async (req, res) => {
        const rateLimitState = getLoginRateLimitState(req);
        if (rateLimitState.blockedUntil > Date.now()) {
            setFlash(req, "error", "Trop de tentatives de connexion. Réessayez plus tard.");
            return saveSessionAndRedirect(req, res, "/admin/login");
        }

        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");
        const admin = getAdminByUsername(db, username);
        registerLoginAttempt(req);
        const passwordMatches = await verifyPasswordAsync(
            password,
            admin?.password_hash || INVALID_LOGIN_PASSWORD_HASH
        );

        if (!admin || !passwordMatches) {
            setFlash(req, "error", "Identifiants invalides.");
            return saveSessionAndRedirect(req, res, "/admin/login");
        }

        clearLoginAttempts(req);
        req.session.regenerate((error) => {
            if (error) {
                setFlash(req, "error", "Impossible d'ouvrir une session sécurisée.");
                return saveSessionAndRedirect(req, res, "/admin/login");
            }

            req.session.adminId = admin.id;
            req.session.adminAuthVersion = admin.auth_version;
            getOrCreateCsrfToken(req);
            setFlash(req, "success", "Connexion réussie.");
            return saveSessionAndRedirect(req, res, "/");
        });
    });

    app.post("/admin/logout", requireAdmin, (req, res) => {
        req.session.destroy((error) => {
            if (error) {
                logger.error("session.logout_destroy_failed", {
                    requestId: req.requestId,
                    error: error.message,
                });
                return res.status(503).send("Déconnexion temporairement indisponible. Veuillez réessayer.");
            }

            res.clearCookie("connect.sid");
            return res.redirect("/admin/login");
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

            const updatedAdmin = updateAdminUser(db, adminRecord.id, {
                username: input.username,
                role: adminRecord.role,
                password: input.password,
            });
            req.session.adminAuthVersion = updatedAdmin.auth_version;

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
        const adminUser = getAdminById(db, parseInteger(req.params.id, Number.NaN));
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
        const adminId = parseInteger(req.params.id, Number.NaN);
        const existingAdmin = getAdminById(db, adminId);
        if (!existingAdmin) {
            return res.status(404).render("not-found", { title: "Administrateur introuvable" });
        }

        try {
            const input = readAdminUserInput(req.body);
            if (existingAdmin.role === "superadmin" && input.role !== "superadmin" && countAdminsByRole(db, "superadmin") <= 1) {
                throw new Error("Le dernier superadmin ne peut pas être rétrogradé.");
            }

            const updatedAdmin = updateAdminUser(db, adminId, input);
            if (adminId === req.currentAdmin.id) {
                req.session.adminAuthVersion = updatedAdmin.auth_version;
            }
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
        const adminId = parseInteger(req.params.id, Number.NaN);
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
