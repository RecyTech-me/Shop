const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

function createImageUpload(uploadDir, maxFiles) {
    return multer({
        storage: multer.diskStorage({
            destination: (req, file, callback) => {
                callback(null, uploadDir);
            },
            filename: (req, file, callback) => {
                const extensionByMimeType = {
                    "image/jpeg": ".jpg",
                    "image/png": ".png",
                    "image/webp": ".webp",
                    "image/gif": ".gif",
                };
                const extension = extensionByMimeType[file.mimetype] || ".img";
                callback(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`);
            },
        }),
        limits: {
            fileSize: 8 * 1024 * 1024,
            files: maxFiles,
        },
        fileFilter: (req, file, callback) => {
            if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)) {
                return callback(new Error("Seules les images JPG, PNG, WebP ou GIF peuvent être importées."));
            }

            callback(null, true);
        },
    });
}

function detectStoredImageFormat(filePath) {
    try {
        const header = fs.readFileSync(filePath, { encoding: null, flag: "r" }).subarray(0, 16);

        if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
            return "jpeg";
        }

        if (
            header.length >= 8 &&
            header[0] === 0x89 &&
            header[1] === 0x50 &&
            header[2] === 0x4e &&
            header[3] === 0x47 &&
            header[4] === 0x0d &&
            header[5] === 0x0a &&
            header[6] === 0x1a &&
            header[7] === 0x0a
        ) {
            return "png";
        }

        const gifHeader = header.subarray(0, 6).toString("ascii");
        if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
            return "gif";
        }

        if (
            header.length >= 12 &&
            header.subarray(0, 4).toString("ascii") === "RIFF" &&
            header.subarray(8, 12).toString("ascii") === "WEBP"
        ) {
            return "webp";
        }
    } catch {
        return "";
    }

    return "";
}

function cleanupUploadedFiles(files = []) {
    for (const file of files) {
        if (!file?.path) {
            continue;
        }

        try {
            fs.unlinkSync(file.path);
        } catch {
            // Ignore cleanup failures.
        }
    }
}

function validateStoredImageUploads(files = []) {
    const invalidFiles = files.filter((file) => !detectStoredImageFormat(file.path));
    if (!invalidFiles.length) {
        return;
    }

    cleanupUploadedFiles(invalidFiles);
    throw new Error("Une ou plusieurs images importées sont invalides ou corrompues.");
}

function uploadUrl(file, folder) {
    if (!file?.filename) {
        return "";
    }

    return `/static/uploads/${folder}/${file.filename}`;
}

function productUploadUrl(file) {
    return uploadUrl(file, "products");
}

function settingsUploadUrl(file) {
    return uploadUrl(file, "settings");
}

function isProductUploadRequest(req) {
    return req.method === "POST" && (
        req.path === "/admin/products/new" ||
        /^\/admin\/products\/\d+\/edit$/.test(req.path)
    ) && req.is("multipart/form-data");
}

function isSettingsUploadRequest(req) {
    return req.method === "POST" && req.path === "/admin/settings" && req.is("multipart/form-data");
}

function productInputWithUploads(req) {
    const input = { ...req.body };
    const primaryUpload = productUploadUrl(req.files?.image_file?.[0]);
    const galleryUploads = (req.files?.gallery_files || []).map(productUploadUrl).filter(Boolean);
    const existingGalleryUrls = String(input.image_gallery_urls || "").trim();

    if (primaryUpload) {
        input.image_url = primaryUpload;
    }

    if (!input.image_url && galleryUploads.length) {
        input.image_url = galleryUploads.shift();
    }

    if (galleryUploads.length) {
        input.image_gallery_urls = [existingGalleryUrls, ...galleryUploads]
            .filter(Boolean)
            .join("\n");
    }

    return input;
}

function buildProductFormState(input = {}, baseProduct = null) {
    const rawPrice = input.price_chf;
    const derivedPrice = baseProduct && Number.isFinite(baseProduct.price_cents)
        ? (baseProduct.price_cents / 100).toFixed(2)
        : "";

    return {
        ...(baseProduct || {}),
        product_kind: input.product_kind ?? baseProduct?.product_kind ?? "product",
        name: input.name ?? baseProduct?.name ?? "",
        categories_text: input.categories ?? baseProduct?.categories_text ?? baseProduct?.category ?? "",
        price_chf: rawPrice ?? derivedPrice,
        inventory: input.inventory ?? baseProduct?.inventory ?? 0,
        image_url: input.image_url ?? baseProduct?.image_url ?? "",
        image_gallery_text: input.image_gallery_urls ?? baseProduct?.image_gallery_text ?? "",
        short_description: input.short_description ?? baseProduct?.short_description ?? "",
        description: input.description ?? baseProduct?.description ?? "",
        admin_notes: input.admin_notes ?? baseProduct?.admin_notes ?? "",
        option_groups_text: input.option_groups ?? baseProduct?.option_groups_text ?? "",
        valid_configurations_text: input.valid_configurations ?? baseProduct?.valid_configurations_text ?? "",
        bundle_items_text: input.bundle_items ?? baseProduct?.bundle_items_text ?? "",
        info_rows_text: input.info_rows ?? baseProduct?.info_rows_text ?? "",
        featured: input.featured ? 1 : 0,
        published: input.published ? 1 : 0,
    };
}

function createUploadHandlers(options) {
    const {
        productUploadDir,
        settingsUploadDir,
        setFlash,
        saveSessionAndRedirect,
    } = options;
    const productImageUpload = createImageUpload(productUploadDir, 13);
    const settingsImageUpload = createImageUpload(settingsUploadDir, 1);

    function ensureUploadDirectory(req, res, directoryPath) {
        try {
            fs.mkdirSync(directoryPath, { recursive: true });
            return true;
        } catch (error) {
            setFlash(req, "error", `Préparation du dossier d'import impossible : ${error.message}`);
            saveSessionAndRedirect(req, res, req.get("referer") || req.originalUrl || "/admin");
            return false;
        }
    }

    function withProductUploads(req, res, next) {
        if (req.productUploadsParsed) {
            return next();
        }

        if (!ensureUploadDirectory(req, res, productUploadDir)) {
            return undefined;
        }

        productImageUpload.fields([
            { name: "image_file", maxCount: 1 },
            { name: "gallery_files", maxCount: 12 },
        ])(req, res, (error) => {
            if (error) {
                setFlash(req, "error", error.message || "L'import des images a échoué.");
                return saveSessionAndRedirect(req, res, req.get("referer") || req.originalUrl || "/admin/products/new");
            }

            try {
                validateStoredImageUploads([
                    ...(req.files?.image_file || []),
                    ...(req.files?.gallery_files || []),
                ]);
            } catch (validationError) {
                setFlash(req, "error", validationError.message);
                return saveSessionAndRedirect(req, res, req.get("referer") || req.originalUrl || "/admin/products/new");
            }

            req.productUploadsParsed = true;
            return next();
        });
    }

    function withSettingsUpload(req, res, next) {
        if (req.settingsUploadParsed) {
            return next();
        }

        if (!ensureUploadDirectory(req, res, settingsUploadDir)) {
            return undefined;
        }

        settingsImageUpload.single("hero_image_file")(req, res, (error) => {
            if (error) {
                setFlash(req, "error", error.message || "L'import de l'image a échoué.");
                return saveSessionAndRedirect(req, res, req.get("referer") || req.originalUrl || "/admin/settings");
            }

            try {
                validateStoredImageUploads(req.file ? [req.file] : []);
            } catch (validationError) {
                setFlash(req, "error", validationError.message);
                return saveSessionAndRedirect(req, res, req.get("referer") || req.originalUrl || "/admin/settings");
            }

            req.settingsUploadParsed = true;
            return next();
        });
    }

    return {
        settingsUploadUrl,
        withProductUploads,
        withSettingsUpload,
        isProductUploadRequest,
        isSettingsUploadRequest,
        productInputWithUploads,
        buildProductFormState,
    };
}

module.exports = { createUploadHandlers };
