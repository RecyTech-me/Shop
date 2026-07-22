const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp } = require("../app");

function createTestServer(t) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recytech-admin-flow-"));
    const app = createApp({
        rootDir: path.join(__dirname, ".."),
        databasePath: path.join(tempDir, "shop.db"),
        startBackgroundTasks: false,
        env: {
            ...process.env,
            NODE_ENV: "test",
            ADMIN_USERNAME: "admin",
            ADMIN_PASSWORD: "test-admin-password",
            SESSION_SECRET: "admin-flow-session-secret",
            ORDER_VIEW_TOKEN_SECRET: "admin-flow-order-view-secret",
        },
    });
    const server = app.listen(0, "127.0.0.1");

    t.after(() => new Promise((resolve) => {
        server.close(() => {
            app.locals.runtime?.stop();
            fs.rmSync(tempDir, { recursive: true, force: true });
            resolve();
        });
    }));

    return new Promise((resolve) => {
        server.once("listening", () => {
            resolve(`http://127.0.0.1:${server.address().port}`);
        });
    });
}

function createClient(baseUrl) {
    let cookie = "";
    let csrfToken = "";

    function updateCookies(response) {
        const setCookies = typeof response.headers.getSetCookie === "function"
            ? response.headers.getSetCookie()
            : [];
        const jar = new Map(cookie.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
            const index = part.indexOf("=");
            return [part.slice(0, index), part.slice(index + 1)];
        }));

        for (const setCookie of setCookies) {
            const pair = setCookie.split(";")[0];
            const index = pair.indexOf("=");
            if (index > 0) {
                jar.set(pair.slice(0, index), pair.slice(index + 1));
            }
        }

        cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    }

    function readCsrf(html) {
        const match = html.match(/name="_csrf" value="([^"]+)"/) ||
            html.match(/name="csrf-token" content="([^"]+)"/);
        assert.ok(match, "Expected page to expose a CSRF token");
        csrfToken = match[1];
    }

    async function request(targetPath, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (cookie) {
            headers.cookie = cookie;
        }

        const response = await fetch(`${baseUrl}${targetPath}`, {
            redirect: "manual",
            ...options,
            headers,
        });
        updateCookies(response);
        const text = await response.text();

        if ((response.headers.get("content-type") || "").includes("text/html")) {
            readCsrf(text);
        }

        return {
            response,
            text,
            location: response.headers.get("location"),
        };
    }

    async function postForm(targetPath, values = {}) {
        return request(targetPath, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                _csrf: csrfToken,
                ...values,
            }),
        });
    }

    async function postMultipart(targetPath, values = {}, files = []) {
        const body = new FormData();
        body.set("_csrf", csrfToken);
        Object.entries(values).forEach(([key, value]) => {
            body.set(key, value);
        });
        files.forEach((file) => {
            body.set(file.name, file.value, file.filename);
        });

        return request(targetPath, {
            method: "POST",
            body,
        });
    }

    async function follow(result) {
        assert.ok(result.location, "Expected redirect location");
        return request(result.location);
    }

    return {
        request,
        postForm,
        postMultipart,
        follow,
    };
}

function listProductUploadFiles() {
    const uploadDir = path.join(__dirname, "..", "public", "uploads", "products");
    if (!fs.existsSync(uploadDir)) {
        return [];
    }

    return fs.readdirSync(uploadDir).sort();
}

function removeProductUploadFiles(fileNames = []) {
    const uploadDir = path.join(__dirname, "..", "public", "uploads", "products");

    for (const fileName of fileNames) {
        fs.rmSync(path.join(uploadDir, fileName), { force: true });
    }
}

function tinyPngBlob() {
    return new Blob([
        Buffer.from(
            "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
            "1f15c4890000000a49444154789c6360000002000100ffff03000006000557bfab" +
            "0000000049454e44ae426082",
            "hex"
        ),
    ], { type: "image/png" });
}

test("admin workflows cover login, settings, product creation, review moderation, and logout", async (t) => {
    const baseUrl = await createTestServer(t);
    const client = createClient(baseUrl);
    const uploadedFilesToClean = [];

    t.after(() => removeProductUploadFiles(uploadedFilesToClean));

    let page = await client.request("/admin/login");
    assert.equal(page.response.status, 200);
    assert.match(page.text, /Connexion/);

    let result = await client.postForm("/admin/login", {
        username: "admin",
        password: "test-admin-password",
    });
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    assert.equal(page.response.status, 200);
    assert.match(page.text, /Tableau de bord/);

    page = await client.request("/admin/admins/new");
    assert.equal(page.response.status, 200);
    result = await client.postForm("/admin/admins/new", {
        username: "catalog-admin",
        role: "admin",
        password: "catalog-admin-password",
    });
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    assert.match(page.text, /catalog-admin/);

    result = await client.postForm("/admin/logout");
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    assert.match(page.text, /Connexion/);

    result = await client.postForm("/admin/login", {
        username: "catalog-admin",
        password: "catalog-admin-password",
    });
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    assert.equal(page.response.status, 200);
    result = await client.request("/admin/admins");
    assert.equal(result.response.status, 302);
    assert.equal(result.location, "/admin");
    page = await client.follow(result);
    assert.match(page.text, /Accès réservé aux superadmins/);

    page = await client.request("/admin/settings");
    assert.equal(page.response.status, 200);
    result = await client.postForm("/admin/settings", {
        store_name: "RecyTech Test Shop",
        tagline: "Quality gate covered",
        hero_title: "Test hero",
        hero_text: "Test hero copy",
        hero_image_url: "/static/images/illustrations/hero-workshop.jpg",
        hero_points: "Point A\nPoint B",
        support_email: "support@example.test",
        support_address: "Rue Test 1",
        bank_account_holder: "RecyTech",
        bank_name: "Test Bank",
        bank_account_number: "123",
        bank_iban: "CH00 0000 0000 0000 0000 0",
        bank_bic: "",
        smtp_host: "",
        smtp_port: "587",
        smtp_secure: "",
        smtp_username: "",
        smtp_password: "",
        smtp_from_name: "RecyTech",
        smtp_from_email: "",
        order_notification_email: "",
    });
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    assert.match(page.text, /Paramètres enregistrés/);

    page = await client.request("/admin/products/new");
    assert.equal(page.response.status, 200);
    const productName = `Admin Flow Laptop ${Date.now()}`;
    result = await client.postForm("/admin/products/new", {
        product_kind: "product",
        name: productName,
        categories: "Tests",
        price_chf: "199.00",
        inventory: "2",
        image_url: "/static/images/recytech-logo.svg",
        image_gallery_urls: "",
        short_description: "Created by an integration test.",
        description: "This product validates the admin product form.",
        admin_notes: "Private note",
        bundle_items: "",
        option_groups: "",
        valid_configurations: "",
        info_rows: "CPU: Test",
        featured: "1",
        published: "1",
    });
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    assert.match(page.text, new RegExp(productName));
    const productId = page.text.match(new RegExp(`${productName}[\\s\\S]*?/admin/products/(\\d+)/edit`))?.[1];
    assert.ok(productId, "Expected created product edit link");

    page = await client.request("/admin/products/new");
    assert.equal(page.response.status, 200);
    result = await client.postMultipart("/admin/products/new", {
        product_kind: "product",
        name: "Rejected Upload",
        categories: "Tests",
        price_chf: "19.00",
        inventory: "1",
        image_url: "",
        image_gallery_urls: "",
        short_description: "Invalid upload test.",
        description: "This should not be created because the file is not an image.",
        admin_notes: "",
        bundle_items: "",
        option_groups: "",
        valid_configurations: "",
        info_rows: "",
        published: "1",
    }, [
        {
            name: "image_file",
            value: new Blob(["not an image"], { type: "text/plain" }),
            filename: "not-an-image.txt",
        },
    ]);
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    assert.match(page.text, /Seules les images JPG, PNG, WebP ou GIF peuvent être importées/);

    const uploadsBeforeValidationFailure = listProductUploadFiles();
    result = await client.postMultipart("/admin/products/new", {
        product_kind: "pack",
        name: "Rejected Pack Upload",
        categories: "Tests",
        price_chf: "19.00",
        inventory: "1",
        image_url: "",
        image_gallery_urls: "",
        short_description: "Valid image upload with invalid product fields.",
        description: "The uploaded file should be deleted because the pack has no items.",
        admin_notes: "",
        bundle_items: "",
        option_groups: "",
        valid_configurations: "",
        info_rows: "",
        published: "1",
    }, [
        {
            name: "image_file",
            value: tinyPngBlob(),
            filename: "valid-but-rejected.png",
        },
    ]);
    assert.equal(result.response.status, 400);
    assert.match(result.text, /Création impossible/);
    assert.deepEqual(listProductUploadFiles(), uploadsBeforeValidationFailure);

    const uploadsBeforeSuccessfulUpload = listProductUploadFiles();
    const uploadedProductName = `Uploaded Image Laptop ${Date.now()}`;
    result = await client.postMultipart("/admin/products/new", {
        product_kind: "product",
        name: uploadedProductName,
        categories: "Tests",
        price_chf: "149.00",
        inventory: "1",
        image_url: "",
        image_gallery_urls: "",
        short_description: "Successful derivative generation test.",
        description: "This product validates optimized upload URLs.",
        admin_notes: "",
        bundle_items: "",
        option_groups: "",
        valid_configurations: "",
        info_rows: "",
        published: "",
    }, [
        {
            name: "image_file",
            value: tinyPngBlob(),
            filename: "derivative-source.png",
        },
    ]);
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    const uploadedProductId = page.text.match(new RegExp(`${uploadedProductName}[\\s\\S]*?/admin/products/(\\d+)/edit`))?.[1];
    assert.ok(uploadedProductId, "Expected uploaded product edit link");
    const uploadedFiles = listProductUploadFiles().filter((fileName) => !uploadsBeforeSuccessfulUpload.includes(fileName));
    uploadedFilesToClean.push(...uploadedFiles);
    assert.ok(uploadedFiles.some((fileName) => fileName.endsWith("-display.webp")), "Expected uploaded image derivative");
    page = await client.request(`/admin/products/${uploadedProductId}/edit`);
    assert.match(page.text, /-display\.webp/);
    removeProductUploadFiles(uploadedFiles);

    page = await client.request("/admin/orders/new");
    assert.equal(page.response.status, 200);
    result = await client.postForm("/admin/orders/new", {
        customer_name: "Integration Customer",
        customer_email: "order@example.test",
        customer_phone: "",
        payment_label: "Vente test",
        order_created_at: "2026-06-23T12:00",
        product_id: productId,
        quantity: "1",
        unit_price_chf: "",
        discount_chf: "",
        actual_received_chf: "",
        promo_code: "",
        status: "pending",
        internal_note: "Created by the admin integration test.",
    });
    assert.equal(result.response.status, 302);
    const orderId = result.location.match(/\/admin\/orders\/(\d+)/)?.[1];
    assert.ok(orderId, "Expected manual order detail redirect");
    page = await client.follow(result);
    assert.match(page.text, /Commande/);
    result = await client.postForm(`/admin/orders/${orderId}/send-email`, {
        subject: "Test order update",
        message: "This message should be blocked because SMTP is not configured.",
    });
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    assert.match(page.text, /Envoi impossible/);

    page = await client.request("/");
    assert.match(page.text, new RegExp(productName));
    result = await client.postForm("/reviews", {
        rating: "5",
        reviewer_name: "Integration Customer",
        reviewer_email: "customer@example.test",
        title: "Great shop",
        body: "The whole shop experience was clear and easy.",
    });
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    assert.match(page.text, /Merci ! Nous vérifions les avis avant publication pour éviter le spam\./);
    assert.doesNotMatch(page.text, /Great shop/);

    page = await client.request("/admin#reviews");
    assert.match(page.text, /Integration Customer/);
    const reviewId = page.text.match(/\/admin\/reviews\/(\d+)\/approve/)?.[1];
    assert.ok(reviewId, "Expected pending review approve action");
    result = await client.postForm(`/admin/reviews/${reviewId}/approve`);
    assert.equal(result.response.status, 302);
    await client.follow(result);

    page = await client.request("/");
    assert.match(page.text, /Great shop/);
    assert.match(page.text, /5\/5/);
    assert.doesNotMatch(page.text, /5\.0\/5/);

    result = await client.postForm("/admin/logout");
    assert.equal(result.response.status, 302);
    page = await client.follow(result);
    assert.match(page.text, /Connexion/);
});
