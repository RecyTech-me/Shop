const assert = require("node:assert/strict");
const test = require("node:test");
const { hashPassword } = require("../lib/auth");
const logger = require("../lib/logger");
const { registerAdminSessionRoutes } = require("../routes/admin-modules/session");

logger.configureLogger({ level: "silent" });

function composeHandlers(handlers) {
    return async function composed(req, res) {
        let index = 0;
        async function next() {
            const handler = handlers[index];
            index += 1;
            if (handler) {
                await handler(req, res, next);
            }
        }
        await next();
    };
}

function createResponse() {
    return {
        statusCode: 200,
        clearedCookies: [],
        status(code) {
            this.statusCode = code;
            return this;
        },
        render(view, options) {
            this.rendered = { view, options };
            return this;
        },
        redirect(target) {
            this.redirectedTo = target;
            return this;
        },
        send(payload) {
            this.sent = payload;
            return this;
        },
        clearCookie(name) {
            this.clearedCookies.push(name);
            return this;
        },
    };
}

function createRequest(options = {}) {
    const session = options.session || {};
    if (!session.regenerate) {
        session.regenerate = (callback) => callback(options.regenerateError || null);
    }
    if (!session.destroy) {
        session.destroy = (callback) => callback(options.destroyError || null);
    }

    return {
        body: {},
        params: {},
        currentAdmin: { id: 1, username: "root", role: "superadmin" },
        flashes: [],
        ...options,
        session,
    };
}

function createAdmin(overrides = {}) {
    return {
        id: 1,
        username: "root",
        password_hash: hashPassword("correct-password"),
        role: "superadmin",
        auth_version: 0,
        created_at: "2026-07-21T10:00:00.000Z",
        ...overrides,
    };
}

function registerRoutes(overrides = {}) {
    const handlers = new Map();
    const calls = [];
    const rootAdmin = overrides.rootAdmin || createAdmin();
    const targetAdmin = Object.prototype.hasOwnProperty.call(overrides, "targetAdmin")
        ? overrides.targetAdmin
        : createAdmin({ id: 2, username: "operator", role: "admin" });
    const defaultAdmins = {
        getAdminByUsername: (_db, username) => {
            if (username === rootAdmin.username) {
                return rootAdmin;
            }
            if (targetAdmin && username === targetAdmin.username) {
                return targetAdmin;
            }
            return null;
        },
        getAdminById: (_db, id) => {
            if (id === rootAdmin.id) {
                return rootAdmin;
            }
            return targetAdmin && id === targetAdmin.id ? targetAdmin : null;
        },
        listAdmins: () => [rootAdmin, targetAdmin].filter(Boolean),
        countAdminsByRole: (_db, role) => role === "superadmin" ? 1 : 1,
        createAdminUser: (_db, input) => {
            calls.push(["createAdmin", input]);
            return createAdmin({ id: 3, ...input });
        },
        updateAdminUser: (_db, id, input) => {
            calls.push(["updateAdmin", id, input]);
            const current = id === rootAdmin.id ? rootAdmin : targetAdmin;
            return { ...current, ...input, id, auth_version: current.auth_version + 1 };
        },
        deleteAdminUser: (_db, id) => {
            calls.push(["deleteAdmin", id]);
            return true;
        },
    };
    const defaultForms = {
        readAdminUserInput: (body, options = {}) => {
            if (body.invalid) {
                throw new Error("Administrateur invalide.");
            }
            if (options.requirePassword && !body.password) {
                throw new Error("Le mot de passe est obligatoire.");
            }
            return {
                username: body.username || "operator",
                role: body.role || "admin",
                password: body.password || "",
            };
        },
        readAdminAccountInput: (body, currentAdmin) => {
            if (body.invalid) {
                throw new Error("Compte invalide.");
            }
            const username = body.username || currentAdmin.username;
            return {
                username,
                currentPassword: body.current_password || "",
                password: body.password || "",
                usernameChanged: username !== currentAdmin.username,
                passwordChanged: Boolean(body.password),
            };
        },
    };
    const deps = {
        app: {
            get(path, ...routeHandlers) {
                handlers.set(`GET ${path}`, composeHandlers(routeHandlers));
            },
            post(path, ...routeHandlers) {
                handlers.set(`POST ${path}`, composeHandlers(routeHandlers));
            },
        },
        db: {},
        http: {
            requireAdmin: (req, res, next) => next(),
            requireSuperadmin: (req, res, next) => next(),
            render: (res, view, options) => res.render(view, options),
            setFlash: (req, type, message) => {
                calls.push(["flash", type, message]);
                req.flashes.push({ type, message });
            },
            saveSessionAndRedirect: (req, res, target) => {
                calls.push(["redirect", target]);
                return res.redirect(target);
            },
            getLoginRateLimitState: () => ({ blockedUntil: 0 }),
            registerLoginAttempt: () => calls.push(["loginAttempt"]),
            clearLoginAttempts: () => calls.push(["clearLoginAttempts"]),
            getOrCreateCsrfToken: (req) => {
                calls.push(["csrfToken"]);
                req.session.csrfToken = "csrf-token";
                return req.session.csrfToken;
            },
            ...overrides.http,
        },
        forms: {
            ...defaultForms,
            ...overrides.forms,
        },
        admins: {
            ...defaultAdmins,
            ...overrides.admins,
        },
    };

    registerAdminSessionRoutes(deps);
    return {
        calls,
        rootAdmin,
        targetAdmin,
        handler(method, path) {
            return handlers.get(`${method} ${path}`);
        },
    };
}

test("login page renders for guests and redirects authenticated sessions", async () => {
    const routes = registerRoutes();
    const guestResponse = createResponse();
    await routes.handler("GET", "/admin/login")(createRequest(), guestResponse);

    const authenticatedResponse = createResponse();
    await routes.handler("GET", "/admin/login")(
        createRequest({ session: { adminId: 1 } }),
        authenticatedResponse
    );

    assert.equal(guestResponse.rendered.view, "admin/login");
    assert.equal(authenticatedResponse.redirectedTo, "/");
});

test("login rejects blocked and invalid credentials before creating a session", async () => {
    let lookupCount = 0;
    const blockedRoutes = registerRoutes({
        http: {
            getLoginRateLimitState: () => ({ blockedUntil: Date.now() + 60_000 }),
        },
        admins: {
            getAdminByUsername: () => {
                lookupCount += 1;
                return null;
            },
        },
    });
    const blockedRequest = createRequest({ body: { username: "root", password: "correct-password" } });
    const blockedResponse = createResponse();
    await blockedRoutes.handler("POST", "/admin/login")(blockedRequest, blockedResponse);

    const invalidRoutes = registerRoutes();
    const invalidRequest = createRequest({ body: { username: "root", password: "wrong" } });
    const invalidResponse = createResponse();
    await invalidRoutes.handler("POST", "/admin/login")(invalidRequest, invalidResponse);

    assert.equal(lookupCount, 0);
    assert.match(blockedRequest.flashes[0].message, /Trop de tentatives/);
    assert.ok(invalidRoutes.calls.some((call) => call[0] === "loginAttempt"));
    assert.equal(invalidRequest.session.adminId, undefined);
});

test("valid login regenerates the session and creates a CSRF token", async () => {
    const routes = registerRoutes();
    const req = createRequest({ body: { username: "root", password: "correct-password" } });
    const res = createResponse();

    await routes.handler("POST", "/admin/login")(req, res);

    assert.equal(req.session.adminId, routes.rootAdmin.id);
    assert.equal(req.session.adminAuthVersion, routes.rootAdmin.auth_version);
    assert.equal(req.session.csrfToken, "csrf-token");
    assert.equal(res.redirectedTo, "/");
    assert.ok(routes.calls.some((call) => call[0] === "clearLoginAttempts"));
    assert.ok(req.flashes.some((flash) => flash.type === "success"));
});

test("login reports session regeneration failures without authenticating", async () => {
    const routes = registerRoutes();
    const req = createRequest({
        body: { username: "root", password: "correct-password" },
        regenerateError: new Error("session store unavailable"),
    });
    const res = createResponse();

    await routes.handler("POST", "/admin/login")(req, res);

    assert.equal(req.session.adminId, undefined);
    assert.equal(res.redirectedTo, "/admin/login");
    assert.match(req.flashes[0].message, /session sécurisée/);
});

test("logout clears the session cookie and redirects to login", async () => {
    const routes = registerRoutes();
    const req = createRequest({ session: { adminId: 1 } });
    const res = createResponse();

    await routes.handler("POST", "/admin/logout")(req, res);

    assert.deepEqual(res.clearedCookies, ["connect.sid"]);
    assert.equal(res.redirectedTo, "/admin/login");
});

test("logout keeps the cookie and reports an unavailable session store", async () => {
    const routes = registerRoutes();
    const req = createRequest({
        session: { adminId: 1 },
        destroyError: new Error("session store unavailable"),
    });
    const res = createResponse();

    await routes.handler("POST", "/admin/logout")(req, res);

    assert.equal(res.statusCode, 503);
    assert.match(res.sent, /Déconnexion temporairement indisponible/);
    assert.deepEqual(res.clearedCookies, []);
    assert.equal(res.redirectedTo, undefined);
});

test("account page renders and invalid stored sessions are cleared", async () => {
    const routes = registerRoutes();
    const pageResponse = createResponse();
    await routes.handler("GET", "/admin/account")(createRequest(), pageResponse);

    const missingRoutes = registerRoutes({
        admins: { getAdminByUsername: () => null },
    });
    const missingRequest = createRequest({ session: { adminId: 1 } });
    const missingResponse = createResponse();
    await missingRoutes.handler("POST", "/admin/account")(missingRequest, missingResponse);

    assert.equal(pageResponse.rendered.view, "admin/account");
    assert.equal(missingRequest.session.adminId, null);
    assert.equal(missingResponse.redirectedTo, "/admin/login");
});

test("account updates require the current password and report duplicate usernames", async () => {
    const routes = registerRoutes();
    const wrongRequest = createRequest({
        body: { username: "renamed", current_password: "wrong" },
    });
    const wrongResponse = createResponse();
    await routes.handler("POST", "/admin/account")(wrongRequest, wrongResponse);

    const duplicate = new Error("duplicate");
    duplicate.code = "SQLITE_CONSTRAINT_UNIQUE";
    const duplicateRoutes = registerRoutes({
        admins: {
            updateAdminUser: () => {
                throw duplicate;
            },
        },
    });
    const duplicateRequest = createRequest({ body: { username: "root" } });
    const duplicateResponse = createResponse();
    await duplicateRoutes.handler("POST", "/admin/account")(duplicateRequest, duplicateResponse);

    assert.ok(!routes.calls.some((call) => call[0] === "updateAdmin"));
    assert.match(wrongRequest.flashes[0].message, /mot de passe actuel est incorrect/);
    assert.match(duplicateRequest.flashes[0].message, /existe déjà/);
});

test("account updates preserve role and apply verified credential changes", async () => {
    const routes = registerRoutes();
    const req = createRequest({
        body: {
            username: "renamed-root",
            current_password: "correct-password",
            password: "new-password",
        },
    });
    const res = createResponse();

    await routes.handler("POST", "/admin/account")(req, res);

    assert.deepEqual(routes.calls.find((call) => call[0] === "updateAdmin"), [
        "updateAdmin",
        1,
        { username: "renamed-root", role: "superadmin", password: "new-password" },
    ]);
    assert.equal(res.redirectedTo, "/admin/account");
    assert.equal(req.session.adminAuthVersion, 1);
    assert.ok(req.flashes.some((flash) => flash.type === "success"));
});

test("administrator list and creation form expose required view data", async () => {
    const routes = registerRoutes();
    const listResponse = createResponse();
    await routes.handler("GET", "/admin/admins")(createRequest(), listResponse);
    const formResponse = createResponse();
    await routes.handler("GET", "/admin/admins/new")(createRequest(), formResponse);

    assert.equal(listResponse.rendered.options.admins.length, 2);
    assert.equal(listResponse.rendered.options.superadminCount, 1);
    assert.equal(formResponse.rendered.options.currentAdminId, 1);
    assert.ok(formResponse.rendered.options.roleOptions.length >= 2);
});

test("administrator routes reject partially numeric record identifiers", async () => {
    const routes = registerRoutes();
    const res = createResponse();

    await routes.handler("GET", "/admin/admins/:id/edit")(
        createRequest({ params: { id: "2junk" } }),
        res
    );

    assert.equal(res.statusCode, 404);
    assert.equal(res.rendered.view, "not-found");
});

test("administrator creation handles success, validation, and unique conflicts", async () => {
    const routes = registerRoutes();
    const successRequest = createRequest({ body: { username: "new-admin", password: "secret" } });
    const successResponse = createResponse();
    await routes.handler("POST", "/admin/admins/new")(successRequest, successResponse);

    const invalidRoutes = registerRoutes();
    const invalidRequest = createRequest({ body: { invalid: true } });
    const invalidResponse = createResponse();
    await invalidRoutes.handler("POST", "/admin/admins/new")(invalidRequest, invalidResponse);

    const duplicate = new Error("duplicate");
    duplicate.code = "SQLITE_CONSTRAINT_UNIQUE";
    const duplicateRoutes = registerRoutes({
        admins: {
            createAdminUser: () => {
                throw duplicate;
            },
        },
    });
    const duplicateRequest = createRequest({ body: { username: "root", password: "secret" } });
    const duplicateResponse = createResponse();
    await duplicateRoutes.handler("POST", "/admin/admins/new")(duplicateRequest, duplicateResponse);

    assert.equal(successResponse.redirectedTo, "/admin/admins");
    assert.ok(routes.calls.some((call) => call[0] === "createAdmin"));
    assert.match(invalidRequest.flashes[0].message, /invalide/);
    assert.match(duplicateRequest.flashes[0].message, /existe déjà/);
});

test("administrator edit returns 404 for missing records and renders existing records", async () => {
    const missingRoutes = registerRoutes({ targetAdmin: null });
    const missingResponse = createResponse();
    await missingRoutes.handler("GET", "/admin/admins/:id/edit")(
        createRequest({ params: { id: "2" } }),
        missingResponse
    );
    const missingUpdateResponse = createResponse();
    await missingRoutes.handler("POST", "/admin/admins/:id/edit")(
        createRequest({ params: { id: "2" }, body: { username: "missing" } }),
        missingUpdateResponse
    );

    const routes = registerRoutes();
    const foundResponse = createResponse();
    await routes.handler("GET", "/admin/admins/:id/edit")(
        createRequest({ params: { id: "2" } }),
        foundResponse
    );

    assert.equal(missingResponse.statusCode, 404);
    assert.equal(missingUpdateResponse.statusCode, 404);
    assert.equal(foundResponse.rendered.options.formAction, "/admin/admins/2/edit");
});

test("administrator edit protects the final superadmin and updates safe changes", async () => {
    const protectedRoutes = registerRoutes();
    const protectedRequest = createRequest({ params: { id: "1" }, body: { username: "root", role: "admin" } });
    const protectedResponse = createResponse();
    await protectedRoutes.handler("POST", "/admin/admins/:id/edit")(protectedRequest, protectedResponse);

    const routes = registerRoutes();
    const successRequest = createRequest({ params: { id: "2" }, body: { username: "operator-2", role: "admin" } });
    const successResponse = createResponse();
    await routes.handler("POST", "/admin/admins/:id/edit")(successRequest, successResponse);

    assert.ok(!protectedRoutes.calls.some((call) => call[0] === "updateAdmin"));
    assert.match(protectedRequest.flashes[0].message, /dernier superadmin/);
    assert.ok(routes.calls.some((call) => call[0] === "updateAdmin" && call[1] === 2));
    assert.equal(successResponse.redirectedTo, "/admin/admins");
});

test("administrator edit reports unique conflicts", async () => {
    const duplicate = new Error("duplicate");
    duplicate.code = "SQLITE_CONSTRAINT_UNIQUE";
    const routes = registerRoutes({
        admins: {
            updateAdminUser: () => {
                throw duplicate;
            },
        },
    });
    const req = createRequest({ params: { id: "2" }, body: { username: "root", role: "admin" } });
    const res = createResponse();

    await routes.handler("POST", "/admin/admins/:id/edit")(req, res);

    assert.equal(res.redirectedTo, "/admin/admins/2/edit");
    assert.match(req.flashes[0].message, /existe déjà/);
});

test("administrator deletion rejects missing records, self-deletion, and the final superadmin", async () => {
    const missingRoutes = registerRoutes({ targetAdmin: null });
    const missingResponse = createResponse();
    await missingRoutes.handler("POST", "/admin/admins/:id/delete")(
        createRequest({ params: { id: "2" } }),
        missingResponse
    );

    const selfRoutes = registerRoutes();
    const selfRequest = createRequest({ params: { id: "1" } });
    const selfResponse = createResponse();
    await selfRoutes.handler("POST", "/admin/admins/:id/delete")(selfRequest, selfResponse);

    const lastSuperadmin = createAdmin({ id: 2, username: "backup-root" });
    const protectedRoutes = registerRoutes({ targetAdmin: lastSuperadmin });
    const protectedRequest = createRequest({ params: { id: "2" } });
    const protectedResponse = createResponse();
    await protectedRoutes.handler("POST", "/admin/admins/:id/delete")(protectedRequest, protectedResponse);

    assert.equal(missingResponse.statusCode, 404);
    assert.match(selfRequest.flashes[0].message, /propre compte/);
    assert.match(protectedRequest.flashes[0].message, /dernier superadmin/);
    assert.ok(!protectedRoutes.calls.some((call) => call[0] === "deleteAdmin"));
});

test("administrator deletion removes safe targets", async () => {
    const routes = registerRoutes();
    const req = createRequest({ params: { id: "2" } });
    const res = createResponse();

    await routes.handler("POST", "/admin/admins/:id/delete")(req, res);

    assert.deepEqual(routes.calls.find((call) => call[0] === "deleteAdmin"), ["deleteAdmin", 2]);
    assert.equal(res.redirectedTo, "/admin/admins");
    assert.ok(req.flashes.some((flash) => flash.type === "success"));
});
