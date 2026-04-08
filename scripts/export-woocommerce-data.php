<?php

function fail(string $message, int $code = 1): void
{
    fwrite(STDERR, $message . PHP_EOL);
    exit($code);
}

function readWpConfigValue(string $config, string $constant): ?string
{
    $pattern = sprintf("/define\\(\\s*['\\\"]%s['\\\"]\\s*,\\s*['\\\"]([^'\\\"]*)['\\\"]\\s*\\)\\s*;/", preg_quote($constant, "/"));
    if (preg_match($pattern, $config, $matches)) {
        return stripcslashes($matches[1]);
    }

    return null;
}

function readWpTablePrefix(string $config): string
{
    if (preg_match('/\\$table_prefix\\s*=\\s*[\'"]([^\'"]+)[\'"]\\s*;/', $config, $matches)) {
        return $matches[1];
    }

    return "wp_";
}

function fetchAllAssoc(mysqli $db, string $sql): array
{
    $result = $db->query($sql);
    if ($result === false) {
        fail("MySQL query failed: " . $db->error . "\nSQL: " . $sql);
    }

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }

    return $rows;
}

function fetchOneValue(mysqli $db, string $sql): ?string
{
    $rows = fetchAllAssoc($db, $sql);
    if (!$rows) {
        return null;
    }

    $row = $rows[0];
    return array_shift($row);
}

function normalizeText(?string $value): string
{
    $value = html_entity_decode((string)($value ?? ""), ENT_QUOTES | ENT_HTML5, "UTF-8");
    $value = preg_replace("/<br\\s*\\/?>/i", "\n", $value);
    $value = preg_replace("/<\\/p>/i", "\n\n", $value);
    $value = strip_tags($value);
    $value = preg_replace("/[\\t\\r ]+/", " ", $value);
    $value = preg_replace("/\\n{3,}/", "\n\n", $value);
    return trim((string)$value);
}

function cleanLabel(?string $value): string
{
    return rtrim(trim((string)($value ?? "")), " :");
}

function splitPipeValues(?string $value): array
{
    $parts = preg_split("/\\|/", (string)($value ?? ""));
    $clean = [];

    foreach ($parts as $part) {
        $text = normalizeText($part);
        if ($text !== "") {
            $clean[] = $text;
        }
    }

    return array_values(array_unique($clean));
}

function maybeUnserializeValue($value)
{
    if (!is_string($value)) {
        return $value;
    }

    $trimmed = trim($value);
    if ($trimmed === "") {
        return $trimmed;
    }

    $unserialized = @unserialize($trimmed);
    if ($unserialized !== false || $trimmed === "b:0;") {
        return $unserialized;
    }

    return $value;
}

function normalizeSlugValue(?string $value): string
{
    $value = urldecode((string)($value ?? ""));
    $value = preg_replace("/^pa_/", "", $value);
    $value = str_replace(["-", "_"], " ", $value);
    $value = normalizeText($value);
    return mb_strtolower($value, "UTF-8");
}

function normalizeAttributeKey(string $value): string
{
    $value = preg_replace("/^attribute_/", "", $value);
    $value = preg_replace("/^pa_/", "", $value);
    $value = normalizeText($value);
    $value = iconv("UTF-8", "ASCII//TRANSLIT//IGNORE", $value);
    $value = strtolower((string)$value);
    $value = preg_replace("/[^a-z0-9]+/", "_", $value);
    return trim((string)$value, "_");
}

function uniqueRows(array $rows): array
{
    $seen = [];
    $output = [];

    foreach ($rows as $row) {
        $key = json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $output[] = $row;
    }

    return $output;
}

function buildShortDescription(string $excerpt, string $description): string
{
    if ($excerpt !== "") {
        return $excerpt;
    }

    if ($description === "") {
        return "";
    }

    if (mb_strlen($description, "UTF-8") <= 180) {
        return $description;
    }

    return rtrim(mb_substr($description, 0, 177, "UTF-8")) . "...";
}

function mapOrderStatus(string $status): ?string
{
    return [
        "wc-pending" => "pending",
        "wc-on-hold" => "awaiting_transfer",
        "wc-processing" => "processing",
        "wc-completed" => "completed",
        "wc-cancelled" => "cancelled",
        "wc-failed" => "failed",
        "wc-refunded" => "refunded",
    ][$status] ?? null;
}

function mapPaymentProvider(string $paymentMethod): string
{
    return [
        "stripe" => "stripe",
        "bacs" => "transfer",
        "cod" => "cash",
        "cheque" => "manual",
        "bitcoin" => "btcpay",
    ][strtolower($paymentMethod)] ?? strtolower($paymentMethod ?: "manual");
}

function parseAddressRows(array $rows): array
{
    $addresses = [];

    foreach ($rows as $row) {
        $addresses[$row["order_id"]][$row["address_type"]] = [
            "first_name" => normalizeText($row["first_name"] ?? ""),
            "last_name" => normalizeText($row["last_name"] ?? ""),
            "company" => normalizeText($row["company"] ?? ""),
            "address_1" => normalizeText($row["address_1"] ?? ""),
            "address_2" => normalizeText($row["address_2"] ?? ""),
            "city" => normalizeText($row["city"] ?? ""),
            "state" => normalizeText($row["state"] ?? ""),
            "postcode" => normalizeText($row["postcode"] ?? ""),
            "country" => normalizeText($row["country"] ?? ""),
            "email" => normalizeText($row["email"] ?? ""),
            "phone" => normalizeText($row["phone"] ?? ""),
        ];
    }

    return $addresses;
}

if ($argc < 2) {
    fail("Usage: php export-woocommerce-data.php /path/to/wordpress");
}

$wpRoot = rtrim($argv[1], "/");
$wpConfigPath = $wpRoot . "/wp-config.php";
if (!file_exists($wpConfigPath)) {
    fail("wp-config.php not found at " . $wpConfigPath);
}

$config = file_get_contents($wpConfigPath);
if ($config === false) {
    fail("Unable to read " . $wpConfigPath);
}

$dbName = readWpConfigValue($config, "DB_NAME");
$dbUser = readWpConfigValue($config, "DB_USER");
$dbPassword = readWpConfigValue($config, "DB_PASSWORD");
$dbHost = readWpConfigValue($config, "DB_HOST") ?? "localhost";
$tablePrefix = readWpTablePrefix($config);

if (!$dbName || !$dbUser) {
    fail("Unable to parse WordPress database credentials from wp-config.php");
}

$db = @new mysqli($dbHost, $dbUser, $dbPassword ?? "", $dbName);
if ($db->connect_error) {
    fail("MySQL connection failed: " . $db->connect_error);
}

$db->set_charset("utf8mb4");

$siteUrl = fetchOneValue($db, "SELECT option_value FROM {$tablePrefix}options WHERE option_name = 'home' LIMIT 1")
    ?: fetchOneValue($db, "SELECT option_value FROM {$tablePrefix}options WHERE option_name = 'siteurl' LIMIT 1")
    ?: "";

$productRows = fetchAllAssoc($db, "
    SELECT p.ID, p.post_title, p.post_name, p.post_status, p.post_excerpt, p.post_content, p.post_date_gmt, p.post_modified_gmt
    FROM {$tablePrefix}posts p
    WHERE p.post_type = 'product'
      AND p.post_status NOT IN ('trash', 'auto-draft')
    ORDER BY p.ID ASC
");

$productIds = array_map(fn($row) => (int)$row["ID"], $productRows);
$productIdList = $productIds ? implode(",", array_map("intval", $productIds)) : "0";

$productMetaRows = fetchAllAssoc($db, "
    SELECT post_id, meta_key, meta_value
    FROM {$tablePrefix}postmeta
    WHERE post_id IN ({$productIdList})
      AND meta_key IN (
        '_price', '_stock', '_stock_status', '_manage_stock', '_thumbnail_id', '_product_image_gallery', '_product_attributes'
      )
");

$taxonomyRows = fetchAllAssoc($db, "
    SELECT tr.object_id AS product_id, tt.taxonomy, t.name, t.slug
    FROM {$tablePrefix}term_relationships tr
    JOIN {$tablePrefix}term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
    JOIN {$tablePrefix}terms t ON t.term_id = tt.term_id
    WHERE tr.object_id IN ({$productIdList})
      AND tt.taxonomy IN ('product_cat', 'product_visibility')
");

$variationRows = fetchAllAssoc($db, "
    SELECT ID, post_parent, post_status
    FROM {$tablePrefix}posts
    WHERE post_type = 'product_variation'
      AND post_parent IN ({$productIdList})
      AND post_status NOT IN ('trash', 'auto-draft')
    ORDER BY ID ASC
");

$variationIds = array_map(fn($row) => (int)$row["ID"], $variationRows);
$variationIdList = $variationIds ? implode(",", array_map("intval", $variationIds)) : "0";
$variationMetaRows = $variationIds ? fetchAllAssoc($db, "
    SELECT post_id, meta_key, meta_value
    FROM {$tablePrefix}postmeta
    WHERE post_id IN ({$variationIdList})
") : [];

$attachmentIds = [];
foreach ($productMetaRows as $row) {
    if ($row["meta_key"] === "_thumbnail_id" && $row["meta_value"] !== "") {
        $attachmentIds[] = (int)$row["meta_value"];
    }

    if ($row["meta_key"] === "_product_image_gallery" && $row["meta_value"] !== "") {
        foreach (explode(",", $row["meta_value"]) as $attachmentId) {
            $attachmentId = (int)trim($attachmentId);
            if ($attachmentId > 0) {
                $attachmentIds[] = $attachmentId;
            }
        }
    }
}

$attachmentIds = array_values(array_unique(array_filter($attachmentIds)));
$attachmentIdList = $attachmentIds ? implode(",", $attachmentIds) : "0";
$attachmentRows = $attachmentIds ? fetchAllAssoc($db, "
    SELECT ID, guid
    FROM {$tablePrefix}posts
    WHERE ID IN ({$attachmentIdList})
") : [];

$metaByProduct = [];
foreach ($productMetaRows as $row) {
    $metaByProduct[(int)$row["post_id"]][$row["meta_key"]] = $row["meta_value"];
}

$taxonomyByProduct = [];
foreach ($taxonomyRows as $row) {
    $productId = (int)$row["product_id"];
    $taxonomyByProduct[$productId][$row["taxonomy"]][] = [
        "name" => normalizeText($row["name"]),
        "slug" => normalizeText($row["slug"]),
    ];
}

$variationByParent = [];
foreach ($variationRows as $row) {
    $variationByParent[(int)$row["post_parent"]][] = [
        "id" => (int)$row["ID"],
        "status" => $row["post_status"],
        "meta" => [],
    ];
}

$variationMetaById = [];
foreach ($variationMetaRows as $row) {
    $variationMetaById[(int)$row["post_id"]][$row["meta_key"]] = $row["meta_value"];
}

foreach ($variationByParent as $parentId => $variations) {
    foreach ($variations as $index => $variation) {
        $variationByParent[$parentId][$index]["meta"] = $variationMetaById[$variation["id"]] ?? [];
    }
}

$attachmentUrlById = [];
foreach ($attachmentRows as $row) {
    $attachmentUrlById[(int)$row["ID"]] = normalizeText($row["guid"]);
}

$products = [];

foreach ($productRows as $row) {
    $productId = (int)$row["ID"];
    $meta = $metaByProduct[$productId] ?? [];
    $taxonomies = $taxonomyByProduct[$productId] ?? [];
    $categories = array_values(array_unique(array_map(
        fn($item) => $item["name"],
        $taxonomies["product_cat"] ?? []
    )));
    $visibilityTerms = array_values(array_unique(array_map(
        fn($item) => $item["slug"],
        $taxonomies["product_visibility"] ?? []
    )));

    $description = normalizeText($row["post_content"]);
    $shortDescription = buildShortDescription(normalizeText($row["post_excerpt"]), $description);

    $primaryImageId = (int)($meta["_thumbnail_id"] ?? 0);
    $galleryIds = [];
    foreach (explode(",", (string)($meta["_product_image_gallery"] ?? "")) as $attachmentId) {
        $attachmentId = (int)trim($attachmentId);
        if ($attachmentId > 0 && $attachmentId !== $primaryImageId) {
            $galleryIds[] = $attachmentId;
        }
    }

    $galleryIds = array_values(array_unique($galleryIds));
    $imageUrl = $attachmentUrlById[$primaryImageId] ?? "";
    $galleryUrls = [];
    foreach ($galleryIds as $galleryId) {
        if (!empty($attachmentUrlById[$galleryId])) {
            $galleryUrls[] = $attachmentUrlById[$galleryId];
        }
    }

    $attributeDefinitions = maybeUnserializeValue($meta["_product_attributes"] ?? "");
    if (!is_array($attributeDefinitions)) {
        $attributeDefinitions = [];
    }

    $optionGroups = [];
    $optionGroupsByKey = [];
    $infoRows = [];

    foreach ($attributeDefinitions as $attributeKey => $attribute) {
        if (!is_array($attribute)) {
            continue;
        }

        $label = cleanLabel($attribute["name"] ?? $attributeKey);
        if ($label === "") {
            continue;
        }

        $values = splitPipeValues($attribute["value"] ?? "");
        $isVariation = !empty($attribute["is_variation"]);
        $isVisible = !isset($attribute["is_visible"]) || !empty($attribute["is_visible"]);

        if ($isVariation) {
            $group = [
                "name" => $label,
                "values" => $values,
                "source_key" => normalizeAttributeKey((string)$attributeKey),
            ];
            $optionGroups[] = $group;
            $optionGroupsByKey[$group["source_key"]] = &$optionGroups[array_key_last($optionGroups)];
            continue;
        }

        if ($isVisible) {
            $value = trim(implode(", ", $values));
            if ($value === "" && !empty($attribute["value"])) {
                $value = normalizeText((string)$attribute["value"]);
            }

            if ($value !== "") {
                $infoRows[] = [
                    "label" => $label,
                    "value" => $value,
                ];
            }
        }
    }

    $validConfigurations = [];
    foreach (($variationByParent[$productId] ?? []) as $variation) {
        $selections = [];
        foreach ($variation["meta"] as $metaKey => $metaValue) {
            if (strpos($metaKey, "attribute_") !== 0 || $metaValue === "") {
                continue;
            }

            $groupKey = normalizeAttributeKey($metaKey);
            if (!isset($optionGroupsByKey[$groupKey])) {
                continue;
            }

            $group = &$optionGroupsByKey[$groupKey];
            $rawValue = normalizeText((string)$metaValue);
            $normalizedRaw = normalizeSlugValue($rawValue);
            $matchedValue = "";

            foreach ($group["values"] as $candidateValue) {
                if (normalizeSlugValue($candidateValue) === $normalizedRaw) {
                    $matchedValue = $candidateValue;
                    break;
                }
            }

            if ($matchedValue === "") {
                $matchedValue = $rawValue;
                $group["values"][] = $matchedValue;
                $group["values"] = array_values(array_unique($group["values"]));
            }

            $selections[] = [
                "name" => $group["name"],
                "value" => $matchedValue,
            ];
        }

        if (count($selections) === count($optionGroups) && count($selections) > 0) {
            usort($selections, function ($left, $right) use ($optionGroups) {
                $leftIndex = 999;
                $rightIndex = 999;
                foreach ($optionGroups as $index => $group) {
                    if ($group["name"] === $left["name"]) {
                        $leftIndex = $index;
                    }
                    if ($group["name"] === $right["name"]) {
                        $rightIndex = $index;
                    }
                }
                return $leftIndex <=> $rightIndex;
            });

            $validConfigurations[] = $selections;
        }
    }

    if ($categories) {
        $infoRows[] = [
            "label" => "Catégories",
            "value" => implode(", ", $categories),
        ];
    }

    $products[] = [
        "source_product_id" => $productId,
        "name" => normalizeText($row["post_title"]),
        "slug" => normalizeText($row["post_name"]),
        "status" => normalizeText($row["post_status"]),
        "created_at" => normalizeText($row["post_date_gmt"]) ?: null,
        "updated_at" => normalizeText($row["post_modified_gmt"]) ?: null,
        "description" => $description,
        "short_description" => $shortDescription,
        "price_chf" => (float)($meta["_price"] ?? 0),
        "inventory" => isset($meta["_stock"]) && $meta["_stock"] !== "" ? max(0, (int)$meta["_stock"]) : ((($meta["_stock_status"] ?? "") === "instock") ? 1 : 0),
        "featured" => in_array("featured", $visibilityTerms, true),
        "published" => $row["post_status"] === "publish",
        "image_url" => $imageUrl,
        "gallery_urls" => array_values(array_unique($galleryUrls)),
        "option_groups" => array_map(
            fn($group) => ["name" => $group["name"], "values" => array_values(array_unique($group["values"]))],
            $optionGroups
        ),
        "valid_configurations" => uniqueRows($validConfigurations),
        "info_rows" => uniqueRows($infoRows),
        "categories" => $categories,
    ];
}

$orderRows = fetchAllAssoc($db, "
    SELECT id, status, type, currency, total_amount, customer_id, billing_email, payment_method, transaction_id, date_created_gmt, date_updated_gmt
    FROM {$tablePrefix}wc_orders
    WHERE type = 'shop_order'
      AND status NOT IN ('trash', 'auto-draft', 'wc-checkout-draft')
    ORDER BY id ASC
");

$orderIds = array_map(fn($row) => (int)$row["id"], $orderRows);
$orderIdList = $orderIds ? implode(",", array_map("intval", $orderIds)) : "0";

$addressRows = $orderIds ? fetchAllAssoc($db, "
    SELECT order_id, address_type, first_name, last_name, company, address_1, address_2, city, state, postcode, country, email, phone
    FROM {$tablePrefix}wc_order_addresses
    WHERE order_id IN ({$orderIdList})
") : [];

$orderItemRows = $orderIds ? fetchAllAssoc($db, "
    SELECT oi.order_id, oi.order_item_id, oi.order_item_type, oi.order_item_name, oim.meta_key, oim.meta_value
    FROM {$tablePrefix}woocommerce_order_items oi
    LEFT JOIN {$tablePrefix}woocommerce_order_itemmeta oim ON oim.order_item_id = oi.order_item_id
    WHERE oi.order_id IN ({$orderIdList})
    ORDER BY oi.order_id ASC, oi.order_item_id ASC
") : [];

$addressesByOrder = parseAddressRows($addressRows);
$orderItemsByOrder = [];

foreach ($orderItemRows as $row) {
    $orderId = (int)$row["order_id"];
    $itemId = (int)$row["order_item_id"];
    if (!isset($orderItemsByOrder[$orderId][$itemId])) {
        $orderItemsByOrder[$orderId][$itemId] = [
            "type" => normalizeText($row["order_item_type"]),
            "name" => normalizeText($row["order_item_name"]),
            "meta" => [],
        ];
    }

    if ($row["meta_key"] !== null) {
        $orderItemsByOrder[$orderId][$itemId]["meta"][$row["meta_key"]] = $row["meta_value"];
    }
}

$orders = [];
foreach ($orderRows as $row) {
    $status = mapOrderStatus((string)$row["status"]);
    if ($status === null) {
        continue;
    }

    $billing = $addressesByOrder[(int)$row["id"]]["billing"] ?? [];
    $shipping = $addressesByOrder[(int)$row["id"]]["shipping"] ?? [];
    $customerName = trim(($billing["first_name"] ?? "") . " " . ($billing["last_name"] ?? ""));
    if ($customerName === "") {
        $customerName = trim(($shipping["first_name"] ?? "") . " " . ($shipping["last_name"] ?? ""));
    }
    if ($customerName === "") {
        $customerName = normalizeText($row["billing_email"] ?: "Client WooCommerce");
    }

    $lineItems = [];
    $shippingLines = [];
    $feeLines = [];

    foreach (($orderItemsByOrder[(int)$row["id"]] ?? []) as $item) {
        $meta = $item["meta"];
        $type = $item["type"];

        if ($type === "line_item") {
            $selectedOptions = [];
            foreach ($meta as $metaKey => $metaValue) {
                if ($metaKey === "" || $metaKey[0] === "_") {
                    continue;
                }

                $label = cleanLabel($metaKey);
                $value = normalizeText((string)$metaValue);
                if ($label !== "" && $value !== "") {
                    $selectedOptions[] = ["name" => $label, "value" => $value];
                }
            }

            $quantity = max(1, (int)($meta["_qty"] ?? 1));
            $lineTotalCents = (int)round(((float)($meta["_line_total"] ?? 0)) * 100);
            $unitPriceCents = $quantity > 0 ? (int)round($lineTotalCents / $quantity) : $lineTotalCents;

            $lineItems[] = [
                "source_product_id" => (int)($meta["_product_id"] ?? 0),
                "source_variation_id" => (int)($meta["_variation_id"] ?? 0),
                "name" => $item["name"],
                "quantity" => $quantity,
                "unit_price_cents" => $unitPriceCents,
                "line_total_cents" => $lineTotalCents,
                "selected_options" => $selectedOptions,
            ];
            continue;
        }

        if ($type === "shipping") {
            $amountCents = (int)round(((float)($meta["cost"] ?? $meta["_line_total"] ?? 0)) * 100);
            $shippingLines[] = [
                "label" => $item["name"],
                "amount_cents" => $amountCents,
                "method_id" => normalizeText($meta["method_id"] ?? ""),
            ];
            continue;
        }

        if ($type === "fee") {
            $amountCents = (int)round(((float)($meta["_line_total"] ?? 0)) * 100);
            $feeLines[] = [
                "label" => $item["name"],
                "amount_cents" => $amountCents,
            ];
        }
    }

    $delivery = $shippingLines[0] ?? null;

    $orders[] = [
        "source_order_id" => (int)$row["id"],
        "order_number" => "WC-" . (int)$row["id"],
        "provider" => mapPaymentProvider((string)$row["payment_method"]),
        "provider_reference" => normalizeText($row["transaction_id"]) ?: null,
        "status" => $status,
        "customer_name" => $customerName,
        "customer_email" => normalizeText($row["billing_email"] ?? ""),
        "amount_cents" => (int)round(((float)$row["total_amount"]) * 100),
        "currency" => normalizeText($row["currency"] ?? "CHF") ?: "CHF",
        "created_at" => normalizeText($row["date_created_gmt"]) ?: null,
        "updated_at" => normalizeText($row["date_updated_gmt"]) ?: null,
        "items" => $lineItems,
        "metadata" => [
            "checkout" => [
                "customer_first_name" => $billing["first_name"] ?? "",
                "customer_last_name" => $billing["last_name"] ?? "",
                "shipping_first_name" => $shipping["first_name"] ?? ($billing["first_name"] ?? ""),
                "shipping_last_name" => $shipping["last_name"] ?? ($billing["last_name"] ?? ""),
                "shipping_address1" => trim(($shipping["address_1"] ?? "") . " " . ($shipping["address_2"] ?? "")),
                "shipping_city" => $shipping["city"] ?? "",
                "shipping_region" => $shipping["state"] ?? "",
                "shipping_postal_code" => $shipping["postcode"] ?? "",
                "shipping_country" => $shipping["country"] ?? "",
                "shipping_phone" => $shipping["phone"] ?? ($billing["phone"] ?? ""),
                "billing_first_name" => $billing["first_name"] ?? "",
                "billing_last_name" => $billing["last_name"] ?? "",
                "billing_address1" => trim(($billing["address_1"] ?? "") . " " . ($billing["address_2"] ?? "")),
                "billing_city" => $billing["city"] ?? "",
                "billing_region" => $billing["state"] ?? "",
                "billing_postal_code" => $billing["postcode"] ?? "",
                "billing_country" => $billing["country"] ?? "",
                "billing_phone" => $billing["phone"] ?? "",
            ],
            "delivery" => $delivery ? [
                "method" => stripos($delivery["label"], "retrait") !== false ? "pickup" : "ship",
                "label" => $delivery["label"],
            ] : null,
            "additions" => array_values(array_filter(array_merge(
                array_map(fn($line) => ["label" => "Livraison · " . $line["label"], "amount_cents" => $line["amount_cents"]], $shippingLines),
                array_map(fn($line) => ["label" => "Frais · " . $line["label"], "amount_cents" => $line["amount_cents"]], $feeLines)
            ))),
            "import" => [
                "source" => "woocommerce",
                "source_order_id" => (int)$row["id"],
                "source_status" => normalizeText($row["status"]),
                "source_customer_id" => (int)$row["customer_id"],
            ],
        ],
    ];
}

$capabilityKey = $tablePrefix . "capabilities";
$adminRows = fetchAllAssoc($db, "
    SELECT u.user_login, u.user_email, u.display_name, um.meta_value AS capabilities
    FROM {$tablePrefix}users u
    LEFT JOIN {$tablePrefix}usermeta um
        ON um.user_id = u.ID
       AND um.meta_key = '{$capabilityKey}'
    ORDER BY u.ID ASC
");

$admins = [];
foreach ($adminRows as $row) {
    $capabilities = maybeUnserializeValue($row["capabilities"] ?? "");
    if (!is_array($capabilities) || empty($capabilities["administrator"])) {
        continue;
    }

    $admins[] = [
        "username" => normalizeText($row["user_login"]),
        "email" => normalizeText($row["user_email"]),
        "display_name" => normalizeText($row["display_name"]),
        "role" => "admin",
    ];
}

echo json_encode([
    "generated_at" => gmdate("c"),
    "source" => [
        "wp_root" => $wpRoot,
        "site_url" => $siteUrl,
        "table_prefix" => $tablePrefix,
    ],
    "products" => $products,
    "orders" => $orders,
    "admins" => $admins,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
