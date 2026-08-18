# RecyTech UX/UI Audit

**Audit date:** 18 August 2026  
**Scope:** All public and administrative routes, shared EJS templates, CSS, client-side interactions, server-rendered states, and the 18 supplied desktop screenshots. A targeted local runtime pass also checked the storefront, product, non-empty cart, checkout, and 390 px mobile layouts. No application code was changed.

## 1. Executive assessment

RecyTech is functional and already has a recognizable identity: the warm cream/green palette suits an association focused on reuse, the public site exposes real stock, the product page contains a 12-month warranty and 30-day return promise, the checkout supports pickup as well as delivery, and the admin covers unusually complete operational needs for a small shop. The product does not feel fraudulent or broken on desktop. It does, however, feel like a capable internal application that has received a visual theme, rather than a deliberately designed retail system.

The largest customer-facing weakness is not decoration; it is decision support. Catalogue cards omit condition and key specifications, product condition is buried in an unstructured specification table, delivery and payment expectations arrive late, and there is little visible evidence of the refurbishment process. A new visitor can see what is for sale but cannot quickly judge which computer fits their needs or how trustworthy this specific unit is. The strongest conversion opportunity is to make condition, tested checks, essential specifications, included accessories, warranty, delivery/pickup, and returns visible at the point of decision.

The largest visual weakness is typography. `body` uses a single Raleway semibold face for virtually everything (`public/styles/base-layout.css`), so paragraphs, helper text, labels, legal copy, table data, and headings all carry similar visual weight. The screen therefore looks heavy, green, and flat even when spacing is generous. Cards, pills, borders, and shadows are repeated so widely that they no longer clarify hierarchy. The interface is thematically coherent, but component hierarchy and density are not.

The admin is operationally broad but inefficient for repeated work. Product creation exposes several text-based mini-languages for categories, packs, options, configurations, service tags, and specification rows. Lists have no product search, sorting, selection, or bulk actions. Destructive actions sit beside routine actions as small text links. Manual orders support only one product line, default to a stock-decrementing paid state, and discard entered data on server validation errors. These are workflow defects, not cosmetic preferences.

Mobile readiness requires immediate correction. A live 390 px check found `scrollWidth` larger than `clientWidth` on the storefront, product, cart, and checkout, producing a visible horizontal scrollbar. The checkout summary begins after approximately 2,388 px of form content, so the total is unavailable while the buyer makes delivery and payment decisions. Broken product-gallery images also render as a 460 px blank block on mobile.

No P0 issue was confirmed. The P1 issues collectively create significant conversion, trust, accessibility, and operational risk.

| Dimension | Score |
| --- | ---: |
| Overall UX | 5 |
| Visual quality | 6 |
| Visual consistency | 5 |
| Typography | 4 |
| Color system | 6 |
| Layout & spacing | 5 |
| Storefront usability | 5 |
| Product discoverability | 4 |
| Product-page quality | 5 |
| Purchase flow | 5 |
| Trust / credibility | 5 |
| Copywriting | 5 |
| Mobile readiness | 4 |
| Accessibility | 5 |
| Admin usability | 5 |
| Design-system maturity | 4 |

### What should be preserved

- The warm cream and dark green identity; it is distinctive, restrained, and appropriate to reuse/refurbishment.
- Real inventory counts, multiple product images, structured product options, pickup, warranty, and return information.
- The clear public/admin separation and consistent shared header/footer.
- The admin's direct access to orders, documents, customer contact, analytics, and private operational notes.
- Existing keyboard-visible global focus treatment, skip link, semantic labels, CSRF-safe forms, and responsive table-to-card intent.

## 2. Design-system diagnosis

The application has tokens, but not yet a complete system. `public/styles/base-layout.css` defines backgrounds, surfaces, text/status colors, four radii, one shadow, and price typography. The remaining stylesheets introduce many local rgba colors, new radii (`8px`, `0.9rem`, `1rem`, `1.6rem`, `18px`, `999px`), shadows, spacing values, and component-specific breakpoints. `main.css` imports 18 style modules, but equivalent visual concepts are still encoded independently in catalogue cards, checkout choice cards, analytics cards, order panels, review cards, and responsive navigation.

There are reusable CSS classes—`.button`, `.section-block`, `.detail-panel`, `.chip`, `.admin-form-grid`, `.admin-table`—rather than EJS-level components. That provides partial consistency but does not enforce semantics. A destructive action can therefore use `.button-ghost` and look neutral; a table action can be an unstyled button; a section can nest another `.section-block` and double its border/shadow treatment; and equivalent page headings can be either a bare `.section-heading` or a padded `.section-block`.

The recommended system work is deliberately small:

1. Define semantic typography, spacing, surface, border, shadow, action, focus, and status tokens.
2. Establish canonical primitives for page header, section/card, button/link action, field, status badge, data table, empty state, notice, and destructive confirmation.
3. Add retail-specific patterns: product card, product fact row, condition badge, trust strip, price/availability block, product gallery fallback, checkout summary, and purchase CTA.
4. Add admin patterns: list toolbar, responsive data list, form section, sticky form actions, structured product option builder, and audit/activity timeline.

### [SYS-01] A semibold display face is used as the body face

**Severity:** P1  
**Area:** Global  
**Affected routes:** All  
**Evidence:** All screenshots; `public/styles/base-layout.css:1-12,47-55`; repeated `Raleway-SemiBold` declarations across CSS

**Problem:** The only Raleway asset is semibold and `body` uses it for all text. Legal paragraphs, descriptions, form help, labels, prices, navigation, and headings therefore share a dense weight. Arimo is loaded but used mostly for prices.

**Why it matters:** Long copy is tiring, hierarchy is weak, and the site appears heavier and less refined than its spacing suggests.

**Recommendation:** Use Arimo (or a proper regular text family) at 400/500 for body, fields, tables, and helper copy; reserve Raleway semibold for headings and selected actions. Define a documented type scale with sizes, weights, and line heights.

**Systemic fix:** Typography tokens and text-style utilities/components.

### [SYS-02] Color tokens cover the palette but not component states

**Severity:** P2  
**Area:** Global  
**Affected routes:** All  
**Evidence:** `public/styles/base-layout.css:16-36`; raw colors throughout `catalogue-product-cards.css`, `checkout-choice-controls.css`, `admin-analytics.css`, `footer.css`, and responsive styles

**Problem:** The theme defines core colors, yet hover, selected, border, disabled, chart, chip, card, and focus colors are repeatedly improvised with closely related rgba values.

**Why it matters:** The application looks generally green but not predictably semantic; maintenance will continue to create subtle mismatches.

**Recommendation:** Add semantic tokens for interactive/hover/pressed/selected/disabled, border strengths, success/warning/error/info surfaces and text, focus ring, and chart series. Validate every text/surface pair to WCAG AA.

**Systemic fix:** Semantic color tokens.

### [SYS-03] Cards, pills, borders, and shadows are overused

**Severity:** P2  
**Area:** Global  
**Affected routes:** All public and admin pages  
**Evidence:** All screenshots; `.section-block`, `.detail-panel`, `.product-card`, `.admin-stat-card`, `.choice-surface`, nested order panels

**Problem:** Almost every grouping is a rounded bordered surface, often nested inside another rounded bordered surface. Pills are used for navigation, filters, buttons, stock, state, and social links.

**Why it matters:** When everything is elevated and rounded, nothing is clearly primary. The result is soft but visually monotonous and generic.

**Recommendation:** Use one page surface, one section card, and one inset/quiet panel. Reserve shadows for floating or clearly elevated elements and pills for compact statuses/tags—not all actions.

**Systemic fix:** Canonical surface/elevation and radius rules.

### [SYS-04] Visual hierarchy relies mostly on size, not weight or color roles

**Severity:** P2  
**Area:** Global  
**Affected routes:** All  
**Evidence:** Screenshots; green semibold body text; multiple same-weight headings, labels, metadata, and values

**Problem:** Primary, secondary, and tertiary information frequently share the same color and weight. Admin tables and legal pages are especially uniform.

**Why it matters:** Users scan more slowly and important data—price, condition, order status, required action—does not reliably win attention.

**Recommendation:** Establish explicit display, heading, body, supporting, metadata, and numeric styles. Use muted text only for genuinely secondary content and strong weight sparingly.

**Systemic fix:** Typography roles coupled to content hierarchy.

### [SYS-05] Action hierarchy is not semantic, especially for destructive actions

**Severity:** P1  
**Area:** Global / Admin / Cart  
**Affected routes:** `/cart`, `/admin`, `/admin/orders`, order detail, products, categories, promo codes, administrators  
**Evidence:** Small unstyled “Supprimer” table buttons; neutral `.button-ghost` deletion buttons; `ui-actions.css`; `forms-tables.css:124-136`

**Problem:** Destructive actions often look like ordinary text or a neutral filled pill. Equivalent back/navigation actions have multiple treatments, while frequent and dangerous actions can have equal emphasis.

**Why it matters:** It increases accidental deletion risk and weakens the user's ability to identify the next safe action.

**Recommendation:** Define primary, secondary, quiet, and destructive variants. Destructive actions must use explicit destructive color/copy, adequate hit areas, and consistent confirmation; keep them spatially separated from routine actions.

**Systemic fix:** Semantic Action component/pattern.

### [SYS-06] Icon implementation and visual weight are fragmented

**Severity:** P3  
**Area:** Global  
**Affected routes:** Header, footer, product gallery, filters, checkout  
**Evidence:** Inline SVGs in `header.ejs`, `home.ejs`, `product.ejs`, and `checkout.ejs`; sprite references in `footer.ejs`

**Problem:** The interface mixes hand-authored inline icons and a sprite, with different view boxes, stroke widths, containers, and sizes.

**Why it matters:** Small inconsistencies in icon weight/alignment contribute to the assembled feel and increase maintenance cost.

**Recommendation:** Standardize on one icon source, 20/24 px sizes, stroke rules, and icon-button dimensions. Keep labels for non-obvious actions.

**Systemic fix:** Shared icon partial/helper and icon-button pattern.

### [SYS-07] Page-header and navigation patterns are duplicated

**Severity:** P2  
**Area:** Global / Admin  
**Affected routes:** All admin routes  
**Evidence:** Admin bar plus public header; dashboard duplicates links already in admin bar; varying `.section-heading` structures in templates

**Problem:** Admin users see two stacked navigation systems and many dashboard buttons that repeat the top bar. Page headers vary between bare sections and card-contained sections.

**Why it matters:** It consumes vertical space, creates competing navigation models, and produces inconsistent title/action alignment.

**Recommendation:** Give admin a single dedicated shell with persistent primary navigation and a canonical page header containing title, optional description, and scoped actions.

**Systemic fix:** Shared admin layout and page-header partial.

### [SYS-08] Copy conventions are not governed

**Severity:** P2  
**Area:** Global  
**Affected routes:** Storefront, product, checkout, admin  
**Evidence:** “Email”/“E-mail”/“Adresse e-mail”; “hero”; “fulfillment”; “Laptop”; inconsistent product capitalization; `1 unité(s)`; `x` instead of `×`

**Problem:** Customer-facing French, technical English, internal jargon, and machine-like grammar coexist without a glossary or formatting rules.

**Why it matters:** Inconsistent language lowers perceived care and increases cognitive load for volunteers managing the shop.

**Recommendation:** Adopt a French product/content glossary and rules for e-mail, price, quantity plurals, model capitalization, dates, multiplication, status names, and internal-only terminology.

**Systemic fix:** Content design guide plus shared formatters.

## 3. Global visual issues

### [VIS-01] Container and section density is too uniform

**Severity:** P2  
**Area:** Global  
**Affected routes:** Homepage, legal, admin dashboard, analytics  
**Evidence:** Screenshots; common 1120 px shell and repeated 1.5 rem card padding

**Problem:** Dense tables, long legal copy, hero content, and empty states use variations of the same large rounded container. The homepage catalogue becomes one enormous white slab; legal pages become a stack of equally weighted slabs.

**Why it matters:** Composition lacks rhythm and screen purpose is not reflected in layout.

**Recommendation:** Set content-specific readable widths, vary section separation without always adding cards, and use stronger whitespace transitions between major page regions.

**Systemic fix:** Layout primitives for prose, retail grid, data list, and form pages.

### [VIS-02] Imagery is normalized technically but not art-directed

**Severity:** P2  
**Area:** Storefront / Product  
**Affected routes:** `/`, `/products/:slug`  
**Evidence:** `home.png`, `products_dell-latitude-e5570.png`; different scale, crop, angle, background, and apparent quality across product photos

**Problem:** Product cutouts have inconsistent framing and scale; some nearly fill the card while others float with large margins. Photos communicate catalogue extraction rather than inspected individual refurbished units.

**Why it matters:** Refurbished hardware requires visual proof of real condition. Generic-looking or inconsistent imagery reduces desirability and trust.

**Recommendation:** Define shot requirements (front, keyboard/screen, ports, underside/label where appropriate, and defects), neutral background, consistent margins, minimum resolution, and image QA at publication.

**Systemic fix:** Image policy, admin previews, crop guidance, and publish validation.

### [VIS-03] Empty states are oversized placeholders rather than useful next steps

**Severity:** P3  
**Area:** Storefront / Admin  
**Affected routes:** Cart, reviews, promo codes, categories, dashboard moderation, empty lists  
**Evidence:** `cart.png`, `admin_promo-codes.png`, `admin.png`; `.empty-state`

**Problem:** Most empty states are a sentence centered in a bordered rectangle; some pages leave most of the viewport blank.

**Why it matters:** Empty screens feel unfinished and do not teach users what the feature does or how to proceed.

**Recommendation:** Use concise contextual copy and the relevant primary action; avoid a second decorative inset card when the whole section is already a card.

**Systemic fix:** Reusable empty-state pattern with icon/illustration optional, title, body, and action.

## 4. Storefront audit

### [SF-01] The hero states availability but not RecyTech's strongest reason to believe

**Severity:** P1  
**Area:** Storefront / Homepage  
**Affected routes:** `/`  
**Evidence:** `home.png`; configurable hero fields in `views/home.ejs` and `views/admin/settings.ejs`

**Problem:** “Boutique en ligne RecyTech” and generic bullets explain that products exist, but not who RecyTech is, how refurbishment is performed, the 12-month warranty, local impact, or pickup/delivery reality.

**Why it matters:** A first-time visitor has no compelling, credible answer to “why buy used hardware here?”

**Recommendation:** Lead with refurbished/tested equipment and local association impact, then substantiate with warranty, 30-day returns, transparent condition, and local pickup/delivery. Keep one primary CTA.

**Systemic fix:** Content model for hero proposition and trust facts, not arbitrary newline text.

### [SF-02] Essential trust and fulfilment information is absent from the shopping context

**Severity:** P1  
**Area:** Storefront  
**Affected routes:** `/`, `/products/:slug`, `/cart`  
**Evidence:** Public screenshots and templates; trust details appear mainly in footer, legal pages, and product trust panel

**Problem:** Contact, association identity, pickup location, delivery terms, payment options, warranty, and returns are scattered and often visible only after opening a product or footer/legal page.

**Why it matters:** Buyers assess legitimacy before investing effort. Late reassurance increases abandonment.

**Recommendation:** Add a compact trust strip below the hero and a purchase reassurance block near product/cart CTAs with links to precise policies.

**Systemic fix:** Shared trust-facts component driven by authoritative settings/content.

### [SF-03] Product discovery filters do not match computer-buying decisions

**Severity:** P1  
**Area:** Storefront / Catalogue  
**Affected routes:** `/`  
**Evidence:** `home.png`; filters in `views/home.ejs:38-95`

**Problem:** Discovery offers category, free-text, price, availability, and sort only. Buyers cannot filter laptops by use case, RAM, storage, screen size, condition, OS, or form factor.

**Why it matters:** Non-technical customers cannot reduce a mixed hardware list to suitable choices; technical customers must open many products.

**Recommendation:** First normalize a small set of comparable attributes, then add only high-value filters. For a small catalogue, “For office/study”, “Laptop/desktop”, price, RAM, storage, and availability may be sufficient.

**Systemic fix:** Typed product attributes shared by admin, cards, filters, and product pages.

### [SF-04] Random is the default catalogue ordering

**Severity:** P1  
**Area:** Storefront / Catalogue  
**Affected routes:** `/`  
**Evidence:** `views/home.ejs:51`; `routes/storefront.js`; screenshot filter shows “Aléatoire”

**Problem:** Repeat visits and filter refreshes present an unpredictable order, while “Mis en avant” exists but is not the default.

**Why it matters:** It undermines orientation, makes products hard to relocate, and wastes the curated featured flag.

**Recommendation:** Default to featured then newest/in-stock, with a deterministic tie-breaker. Remove random ordering from the primary customer control unless it serves a proven need.

**Systemic fix:** Catalogue ranking policy.

### [SF-05] Product cards omit the information needed to decide whether to open them

**Severity:** P1  
**Area:** Storefront / Product discovery  
**Affected routes:** `/`  
**Evidence:** `home.png`; `views/home.ejs:110-148`

**Problem:** Cards show category, stock, name, price, and “Voir plus”, but not condition, processor, RAM, storage, screen, OS, warranty, or included accessories.

**Why it matters:** Computers are comparison products. The current cards force repetitive detail-page visits and make low prices look unexplained rather than attractive.

**Recommendation:** Show a standardized 2–4 fact summary by category, condition badge, warranty reassurance, and clear fixed/from pricing. Keep the card compact by omitting low-value stock chips when stock is simply available.

**Systemic fix:** Canonical ProductCard fed by typed summary attributes.

### [SF-06] Card hierarchy and naming are inconsistent

**Severity:** P2  
**Area:** Storefront / Catalogue  
**Affected routes:** `/`  
**Evidence:** `home.png` (“Dell LATITUDE”, “Optiplex”, “Epson-585W”); one/two-line names; mixed “À partir de” and fixed prices

**Problem:** Product capitalization, hyphenation, line lengths, price labels, and chip wrapping vary. The grid aligns CTAs but card bodies contain large arbitrary gaps.

**Why it matters:** Catalogue quality is inferred from data consistency; irregular naming makes inventory appear improvised.

**Recommendation:** Normalize brand/model naming, constrain titles to two lines, explain “from” only for configurable prices, and use a predictable card content order and minimum fact area.

**Systemic fix:** Product content rules, validation, and ProductCard layout.

### [SF-07] Search and advanced filters are visually hidden behind an unlabeled icon

**Severity:** P2  
**Area:** Storefront / Catalogue  
**Affected routes:** `/`  
**Evidence:** Search icon in `home.png`; `<details>` summary with visually hidden label in `views/home.ejs:59-95`

**Problem:** The primary search affordance is a round magnifier with no visible text, while category and sort are fully labeled.

**Why it matters:** Search discoverability is unnecessarily low, especially for visitors looking for a known model.

**Recommendation:** Make search a visible field or a clearly labeled “Rechercher / Filtrer” control and display active filter count/state.

**Systemic fix:** Catalogue toolbar pattern.

### [SF-08] The reviews section advertises the absence of social proof and then asks for work

**Severity:** P1  
**Area:** Storefront / Trust  
**Affected routes:** `/#reviews`  
**Evidence:** `home.png`; no reviews followed by a large five-field review form

**Problem:** “Aucun avis publié” occupies a prominent section, immediately followed by a form larger than many product cards.

**Why it matters:** It makes the shop look new/unvalidated and shifts effort to visitors before establishing trust.

**Recommendation:** Until credible reviews exist, demote the section or replace it with association/refurbishment proof. Once reviews exist, show them first and collapse the contribution form behind a CTA.

**Systemic fix:** Conditional social-proof pattern based on review count.

### [SF-09] Review credibility is underspecified

**Severity:** P2  
**Area:** Storefront / Trust  
**Affected routes:** `/#reviews`  
**Evidence:** `views/home.ejs:153-239`; review data shows name/title/body/rating but no verified-purchase marker

**Problem:** Any visitor can submit a global shop review; displayed reviews do not show verification, purchase relationship, or a clear date/context.

**Why it matters:** Unqualified testimonials can look weak or manipulable rather than reassuring.

**Recommendation:** Label reviews honestly, show date, and add “achat vérifié” only when tied securely to an order. Explain moderation without implying verification that does not exist.

**Systemic fix:** Review trust metadata and presentation rules.

## 5. Product discovery and product pages

### [PD-01] Product condition is buried instead of being a primary purchase fact

**Severity:** P1  
**Area:** Product  
**Affected routes:** `/products/:slug`  
**Evidence:** `products_dell-latitude-e5570.png`; “État: Excellent” appears at the bottom of the specification table

**Problem:** Condition is not visible beside title, price, stock, and CTA. “Testé par RecyTech” is generic and does not describe cosmetic defects or the inspected unit.

**Why it matters:** Condition is one of the first questions in refurbished commerce; hiding it creates hesitation and makes comparison difficult.

**Recommendation:** Put a standardized condition grade and short definition near price, with unit-specific defect notes/photos. Distinguish cosmetic condition, functional test, and battery health.

**Systemic fix:** Condition domain model, badge, rubric, and required admin fields.

### [PD-02] Fulfilment, included items, and payment expectations are missing near the CTA

**Severity:** P1  
**Area:** Product / Conversion  
**Affected routes:** `/products/:slug`  
**Evidence:** Product screenshot and `views/product.ejs:87-168`

**Problem:** The purchase area does not state delivery cost/timing, pickup location/timing, payment methods, or a structured “included” list. A cable appears only inside prose for the example product.

**Why it matters:** Buyers cannot estimate the complete transaction and may fear missing chargers/accessories.

**Recommendation:** Add compact rows for included accessories, pickup/delivery, payment, warranty, and returns directly below/above the CTA; link to detail rather than duplicating legal text.

**Systemic fix:** Product purchase facts component and structured included-items field.

### [PD-03] The product page lacks breadcrumbs and related discovery

**Severity:** P2  
**Area:** Product / Information architecture  
**Affected routes:** `/products/:slug`  
**Evidence:** Product screenshot; template begins directly with gallery/detail and ends at specifications

**Problem:** Category is an eyebrow, not a link. There is no breadcrumb, “back to results”, related product, or next-step discovery.

**Why it matters:** Visitors who reject a product must restart at the homepage and recover their catalogue position/filters.

**Recommendation:** Add linked breadcrumb/back-to-results preserving query state and a small related/alternative products section based on category and price.

**Systemic fix:** Catalogue navigation context and RelatedProducts pattern.

### [PD-04] Broken gallery images fail as large blank media blocks

**Severity:** P1  
**Area:** Product / Resilience  
**Affected routes:** `/products/:slug`  
**Evidence:** Local mobile runtime: broken gallery URLs created a blank 460 px main visual and broken thumbnails; `image-fallbacks.js` targets catalogue/cart only

**Problem:** Product gallery images do not use the fallback behavior already implemented for catalogue cards. The broken `img` remains in the carousel.

**Why it matters:** A missing image dominates the above-the-fold product page and makes the listing appear abandoned.

**Recommendation:** Apply robust load/error handling to main slides and thumbnails, remove failed thumbnails, choose the first valid image, and show a branded placeholder with a useful aspect ratio.

**Systemic fix:** Shared resilient product-image component.

### [PD-05] The gallery is disproportionately tall on mobile

**Severity:** P2  
**Area:** Product / Responsive  
**Affected routes:** `/products/:slug`  
**Evidence:** Runtime at 390 px: `.product-visual-large` measured 460 px high and pushed the product title below the first viewport; `product-reviews.css:9`

**Problem:** Media consumes almost the entire initial viewport before title, condition, price, or CTA.

**Why it matters:** Mobile shoppers cannot confirm what/price/availability without scrolling through media.

**Recommendation:** Use a shorter responsive aspect ratio, place title/price before or alongside the gallery in mobile reading order, and keep thumbnails compact.

**Systemic fix:** Responsive product-detail composition.

### [PD-06] Description and specification content are repetitive and hard to scan

**Severity:** P2  
**Area:** Product / Copy  
**Affected routes:** `/products/:slug`  
**Evidence:** Product screenshot; summary and three long description paragraphs repeat performance claims

**Problem:** Marketing copy repeats the same screen/performance/connectivity ideas, while decisive facts are distributed between prose and a long tinted table.

**Why it matters:** It lengthens the page without increasing confidence.

**Recommendation:** Use a short outcome-focused summary, concise bullet highlights, standardized specifications, condition report, and included-items section. Remove unsupported superlatives such as “excellente réactivité” when not evidenced.

**Systemic fix:** Product content template and editorial rules.

### [PD-07] Specifications are free-form and cannot support reliable comparison

**Severity:** P1  
**Area:** Product / Admin / Discovery  
**Affected routes:** `/products/:slug`, product create/edit, catalogue  
**Evidence:** `info_rows` is parsed from a newline `Libellé: valeur` textarea; different products can use arbitrary labels/units

**Problem:** Key specifications have no controlled schema, units, completeness rules, or category-specific ordering.

**Why it matters:** Cards, filters, comparisons, SEO, and consistent product pages cannot be built reliably; mistakes become customer-facing.

**Recommendation:** Model a small typed attribute set per category, retain optional free-form additional facts, and define display order/unit formatting.

**Systemic fix:** Product attribute schema and structured admin fields.

### [PD-08] Product microcopy exposes implementation-style grammar

**Severity:** P3  
**Area:** Product / Copy  
**Affected routes:** `/products/:slug`  
**Evidence:** “Stock : 1 unité(s)”; uppercase “CATÉGORIES : LAPTOP”; `views/product.ejs:89,110`

**Problem:** Quantity pluralization and category labeling read like generated data rather than customer copy.

**Why it matters:** Small defects accumulate into lower perceived quality.

**Recommendation:** Use plural-aware formatters (“1 en stock”, “3 en stock”) and sentence-case, linked category labels.

**Systemic fix:** Shared quantity/category formatters.

## 6. Cart / purchase journey

### [CK-01] Delivery cost is deferred until checkout

**Severity:** P1  
**Area:** Cart / Conversion  
**Affected routes:** `/cart`, `/checkout`  
**Evidence:** Cart summary says “Livraison — Au paiement”; `views/cart.ejs:88-99`

**Problem:** The buyer reaches the cart without a cost/range or pickup alternative.

**Why it matters:** Unexpected shipping cost is a classic abandonment trigger and is especially salient for low-priced equipment.

**Recommendation:** Show pickup as free and the shipping cost/rule in cart; if variable, show a clear estimate and basis before checkout.

**Systemic fix:** Shared shipping options/pricing presentation.

### [CK-02] Mobile checkout hides the order total below the entire form

**Severity:** P1  
**Area:** Checkout / Responsive  
**Affected routes:** `/checkout`  
**Evidence:** Local 390 px runtime: summary top at ~2388 px; responsive layout simply stacks `.checkout-layout`

**Problem:** Customers select delivery, billing, payment, promo, and notes before seeing the summary/total.

**Why it matters:** Cost is disconnected from choices and confidence, increasing surprise and abandonment.

**Recommendation:** Put a collapsible summary with item count and live total immediately below the page title on mobile and keep a sticky/visible summary on desktop.

**Systemic fix:** Responsive checkout-summary component with one authoritative calculation source.

### [CK-03] Multiple mobile pages have horizontal overflow

**Severity:** P1  
**Area:** Responsive / Global  
**Affected routes:** `/`, `/products/:slug`, `/cart`, `/checkout`  
**Evidence:** Local 390 px runtime repeatedly reported `scrollWidth 383` versus `clientWidth 375` and showed a horizontal scrollbar

**Problem:** Content exceeds the viewport, likely through combined `100vw` menu positioning/shell widths or another shared responsive rule.

**Why it matters:** The page visibly shifts sideways, crops content, and feels broken on phones.

**Recommendation:** Identify the exact overflowing element at 320/360/375/390/430 px, remove `100vw`/offset interactions that include scrollbar width, and add an automated no-horizontal-overflow assertion for key routes.

**Systemic fix:** Responsive shell correction and viewport regression checks.

### [CK-04] Required/optional status and field errors are not presented at field level

**Severity:** P1  
**Area:** Checkout / Forms / Accessibility  
**Affected routes:** `/checkout`  
**Evidence:** Only contact fields and shipping country use HTML `required`; server requires address/postcode/city and billing fields; errors return as top flash

**Problem:** Visually, most fields look equally required. Server validation reports generic “address incomplete” after redirect without associating errors to fields.

**Why it matters:** Users must infer what failed and revisit a long form; screen-reader users do not get error relationships.

**Recommendation:** Mark required fields consistently, add correct HTML constraints, render an error summary plus inline errors with `aria-describedby`/`aria-invalid`, and focus the summary/first invalid field.

**Systemic fix:** Canonical Field and validation-error pattern.

### [CK-05] Quantity changes require a separate explicit update action

**Severity:** P2  
**Area:** Cart  
**Affected routes:** `/cart`  
**Evidence:** Cart template and live mobile cart; number input plus full-width “Mettre à jour”

**Problem:** Quantity, update, and remove consume a large action column/card and changes are not reflected until submission.

**Why it matters:** It adds friction and can leave users unsure whether the total reflects the displayed value.

**Recommendation:** Use accessible stepper controls or update on explicit change with immediate total feedback; retain a no-JS submit fallback.

**Systemic fix:** Cart line-item component with progressive enhancement.

### [CK-06] Remove-from-cart is visually neutral and unconfirmed

**Severity:** P2  
**Area:** Cart  
**Affected routes:** `/cart`  
**Evidence:** `button-ghost` “Retirer”; confirmation pattern is not attached to cart removal

**Problem:** Removal looks like another filled action and executes immediately.

**Why it matters:** Accidental removal is recoverable only by finding/configuring the product again.

**Recommendation:** Make removal a quiet destructive link/icon with clear focus/target size; either offer an undo toast or confirm when configuration recovery is costly.

**Systemic fix:** Destructive/undo interaction pattern.

### [CK-07] Disabled payment methods do not explain availability

**Severity:** P2  
**Area:** Checkout  
**Affected routes:** `/checkout`  
**Evidence:** Disabled card/Bitcoin depend on configuration; `.choice-card-disabled` only lowers opacity; cash appears/disappears with pickup

**Problem:** Unavailable options are dimmed without customer-facing explanation, and payment discounts appear only in option subtitles.

**Why it matters:** Users may interpret disabled methods as a defect and cannot plan alternatives.

**Recommendation:** Hide methods that are not offered or state “indisponible actuellement” with a reason; explain payment discounts consistently in summary and policy text.

**Systemic fix:** Payment-method availability model and component.

### [CK-08] Checkout lacks progress, reassurance, and a clear review moment

**Severity:** P2  
**Area:** Checkout  
**Affected routes:** `/checkout`  
**Evidence:** One long form from contact through payment and note; no steps or review heading

**Problem:** The form is a continuous sequence with no progress cue or final review framing.

**Why it matters:** Long checkout feels more demanding and errors can occur far from the final action.

**Recommendation:** Keep one page, but divide it into numbered semantic sections and a final review/consent area. State that no account is required and what happens next for each payment method.

**Systemic fix:** Checkout section/progress pattern, not necessarily a multi-page flow.

### [CK-09] The final CTA “Commander” is ambiguous about payment obligation

**Severity:** P1  
**Area:** Checkout / Legal clarity  
**Affected routes:** `/checkout`  
**Evidence:** `views/checkout.ejs:280-283`

**Problem:** The button does not state whether it places an order, initiates external payment, or creates an obligation to pay.

**Why it matters:** It weakens informed consent and can conflict with the surrounding legal explanation of contract/payment.

**Recommendation:** Use method-aware explicit copy such as “Commander et payer” or “Confirmer la commande avec obligation de paiement”, and clarify transfer/cash next steps immediately above it. Legal review is recommended for the final wording.

**Systemic fix:** Payment-aware final-action copy rule.

### [CK-10] Success and cancellation pages are operational summaries, not reassuring next steps

**Severity:** P2  
**Area:** Post-purchase  
**Affected routes:** `/checkout/success`, `/checkout/cancel`  
**Evidence:** `views/success.ejs`, `views/cancel.ejs`

**Problem:** Success exposes status, customer name/e-mail, provider details, and bank data as paragraphs. It does not clearly foreground confirmation sent, pickup/delivery next step, support path, or expected timing.

**Why it matters:** The moment of highest customer anxiety lacks a strong confirmation hierarchy.

**Recommendation:** Show success state, order number, amount, next action/timing, contact link, and a concise summary. Structure transfer bank details for copying and state whether an e-mail was sent.

**Systemic fix:** Payment-outcome templates per provider.

### [CK-11] Flash feedback is transient and not announced accessibly

**Severity:** P1  
**Area:** Global / Interaction / Accessibility  
**Affected routes:** All form submissions and cart operations  
**Evidence:** `views/partials/flash.ejs`; `public/scripts/forms.js` hides it after a delay; no `role=status/alert` or live region

**Problem:** Success/error feedback appears near the top and then disappears; focus is not moved and assistive technology is not explicitly notified.

**Why it matters:** Users may wonder whether an action worked, especially after redirects on long pages.

**Recommendation:** Give errors `role="alert"`, successes `role="status"`, keep important errors until dismissed, focus an error summary when appropriate, and preserve the optional action link.

**Systemic fix:** Shared Notice/Toast pattern with accessibility behavior.

## 7. Trust and content

### [TR-01] The shop does not explain the association or refurbishment process in-page

**Severity:** P1  
**Area:** Trust / Information architecture  
**Affected routes:** `/`, product pages  
**Evidence:** “À propos” links to an external site in the footer; hero and product trust copy are brief generic claims

**Problem:** The people, process, local impact, testing checklist, data wiping, and sourcing are not visible in the purchase journey.

**Why it matters:** These are RecyTech's most credible differentiators from anonymous second-hand sellers.

**Recommendation:** Add a concise on-shop “Pourquoi RecyTech?” section/page describing association identity, refurbishment/testing, data handling, support, and impact; link it from header/trust blocks.

**Systemic fix:** Trust content source shared across storefront touchpoints.

### [TR-02] Warranty and return claims are not linked to their conditions

**Severity:** P1  
**Area:** Product / Trust / Legal  
**Affected routes:** `/products/:slug`, `/conditions-generales-de-vente`, `/remboursements-retours`
**Evidence:** Product trust panel states 12 months and 30 days without links or exclusions

**Problem:** Strong commercial claims are shown without immediate access to scope, exclusions, process, or contact.

**Why it matters:** Buyers either distrust the headline or discover qualifications only later.

**Recommendation:** Link each concise claim to the relevant anchored policy section and summarize the practical return/warranty process in plain language.

**Systemic fix:** Authoritative trust-policy facts with reusable anchored links.

### [TR-03] Legal pages lack navigation, update metadata, and direct actions

**Severity:** P2  
**Area:** Legal / Content  
**Affected routes:** All three legal pages  
**Evidence:** Legal screenshots; `views/legal.ejs`

**Problem:** Long pages are stacks of cards with no table of contents, “last updated”, print affordance, anchored sections, or linked e-mail/address text in body copy.

**Why it matters:** Customers cannot quickly verify a specific warranty, return, privacy, or delivery question.

**Recommendation:** Add updated date, concise table of contents, anchors, inline contact links, cross-links between policies, and a readable prose width.

**Systemic fix:** Legal-page layout and metadata model.

### [TR-04] Legal prose is visually exhausting

**Severity:** P2  
**Area:** Legal / Typography  
**Affected routes:** Legal pages  
**Evidence:** Screenshots; semibold full-width paragraphs inside repeated bordered cards

**Problem:** Dense semibold text spans wide cards; every section has equal visual weight.

**Why it matters:** Users are less likely to read the very material intended to build trust.

**Recommendation:** Use regular-weight text, 65–75 character line length, stronger paragraph spacing, selective lists, and fewer decorative containers.

**Systemic fix:** Prose typography and legal-content layout.

### [TR-05] The site lacks unit-specific proof for refurbished condition

**Severity:** P1  
**Area:** Product / Trust  
**Affected routes:** Catalogue and product pages  
**Evidence:** Product images are clean cutouts; condition/test claims are generic; admin notes may contain real diagnostic facts that are not structured publicly

**Problem:** Buyers cannot distinguish a photographed individual unit from a representative model image or see cosmetic defects/test evidence.

**Why it matters:** Refurbished commerce depends on honest specificity. Generic perfection can create suspicion.

**Recommendation:** Mark representative vs actual photos, require defect photos/notes when relevant, and show a compact standardized test report and battery health for portable devices.

**Systemic fix:** Unit/condition evidence model and publication checklist.

## 8. Admin audit

### [AD-01] The dashboard is a long inventory page rather than an action-focused dashboard

**Severity:** P2  
**Area:** Admin / Dashboard  
**Affected routes:** `/admin`  
**Evidence:** `admin.png`; all products and ten recent orders follow KPI cards

**Problem:** The dashboard mixes duplicated navigation, seven KPIs, review moderation, a full product table, and orders into a 3,185 px page.

**Why it matters:** Urgent work (low stock, pending orders, failed payments, reviews) is not prioritized; routine navigation requires scanning.

**Recommendation:** Keep actionable KPIs/queues and recent exceptions; move full inventory to a dedicated product list route and avoid duplicating primary navigation.

**Systemic fix:** Admin information architecture with dedicated Products route/list.

### [AD-02] Product inventory has no search, filters, sorting, pagination, or bulk actions

**Severity:** P1  
**Area:** Admin / Products  
**Affected routes:** `/admin`  
**Evidence:** Product table in `admin.png` and `views/admin/dashboard.ejs`

**Problem:** Every product appears in one static table. There is no filter for draft/out-of-stock/category/featured, no sort, and no bulk publication/category/stock workflow.

**Why it matters:** Management cost grows linearly and volunteers cannot quickly find exceptions.

**Recommendation:** Create `/admin/products` with search, status/category/stock filters, sortable columns, pagination, row selection, and a small set of safe bulk actions.

**Systemic fix:** Admin list toolbar and server-side list query model.

### [AD-03] Private notes overwhelm the product list

**Severity:** P2  
**Area:** Admin / Products  
**Affected routes:** `/admin`  
**Evidence:** `admin.png`; multiline truncated notes appear under names

**Problem:** Diagnostic/location notes compete with product identity and cause irregular row heights.

**Why it matters:** The table becomes hard to scan and sensitive operational notes are exposed more broadly than necessary within admin sessions.

**Recommendation:** Show a short note indicator/preview on demand; prioritize SKU/model, category, price, stock, publication, condition, and updated date.

**Systemic fix:** Column/content policy for product list.

### [AD-04] Table actions are small, crowded, and unsafe

**Severity:** P1  
**Area:** Admin / Accessibility / Safety  
**Affected routes:** Products, orders, promo codes, categories, administrators  
**Evidence:** “Modifier/Gérer/Supprimer” inline links in screenshots; action CSS removes borders/padding

**Problem:** Tiny adjacent text targets provide weak hover/focus affordance; destructive actions sit next to routine actions.

**Why it matters:** This is both a touch/keyboard usability problem and an accidental deletion risk.

**Recommendation:** Make the row itself/open action clear, use a minimum 44 px action menu or spaced buttons, and place destructive actions inside a labeled overflow menu with confirmation.

**Systemic fix:** Accessible responsive RowActions component.

### [AD-05] Admin tables cannot be sorted and statuses are inconsistently encoded

**Severity:** P2  
**Area:** Admin  
**Affected routes:** Dashboard, `/admin/orders`, `/admin/categories`, promo codes, administrators, analytics tables  
**Evidence:** Static table headers; dashboard statuses are plain text while orders use chips

**Problem:** Headers do not sort, numeric/date alignment is inconsistent, and equivalent states use plain text or badges depending on page.

**Why it matters:** Operators cannot answer common questions quickly and visual semantics vary across screens.

**Recommendation:** Define sortable columns per list, align numbers/dates, and use one status badge mapping everywhere.

**Systemic fix:** Canonical DataTable/list pattern and status formatter.

### [AD-06] Product creation exposes fragile text mini-languages

**Severity:** P1  
**Area:** Admin / Product form  
**Affected routes:** `/admin/products/new`, `/admin/products/:id/edit`  
**Evidence:** Product screenshots and `views/admin/product-form.ejs`: categories, gallery URLs, bundle items, option groups, configurations, tags/prices, and info rows are newline/semicolon/pipe DSLs

**Problem:** Users must memorize syntax such as `slug ; qty=2 ; Option=Valeur`, `tags=... => 249.00`, and `Libellé: valeur`.

**Why it matters:** Minor punctuation errors can create invalid pricing/stock/configuration and make routine editing slow.

**Recommendation:** Replace each DSL with structured repeatable rows, searchable product selectors, option/value builders, configuration matrix, currency inputs, and explicit validation. Offer an advanced raw editor only if genuinely needed.

**Systemic fix:** Structured product editor bound to typed domain objects.

### [AD-07] Irrelevant product fields remain visible instead of adapting to product type

**Severity:** P1  
**Area:** Admin / Product form  
**Affected routes:** Product create/edit  
**Evidence:** “Composition du pack”, options, configurations, all image URL/upload controls appear for a simple product

**Problem:** Conditional fields are explained as “ignored” rather than hidden or disabled. The 2,965 px form has no sections or progressive disclosure.

**Why it matters:** It increases cognitive load and makes accidental data entry more likely.

**Recommendation:** Show pack composition only for packs; show configuration matrix only when options exist; group Basics, Condition, Specifications, Media, Inventory/Pricing, Options/Pack, SEO/publication.

**Systemic fix:** Conditional FormSection pattern and explicit product-type state.

### [AD-08] Media management has no previews, ordering, replacement clarity, or deletion controls

**Severity:** P1  
**Area:** Admin / Product media  
**Affected routes:** Product create/edit, settings hero upload  
**Evidence:** Native file controls plus raw URL textareas in screenshots

**Problem:** Existing images are represented as paths; administrators cannot see thumbnails, reorder gallery items, remove one, choose cover, or inspect upload progress/errors.

**Why it matters:** Image quality is central to conversion, yet the workflow makes mistakes difficult to detect.

**Recommendation:** Add thumbnail preview grid, cover selector, reorder/remove actions, file requirements, upload progress, and explicit behavior for adding versus replacing.

**Systemic fix:** Reusable MediaManager component.

### [AD-09] Long forms lack section navigation, sticky actions, and unsaved-change protection

**Severity:** P1  
**Area:** Admin / Forms  
**Affected routes:** Product edit/create, settings, order detail  
**Evidence:** 2,321–2,965 px screenshots; save/delete buttons only at bottom

**Problem:** Users scroll several screens to save, cannot see progress/completeness, and can navigate away without warning.

**Why it matters:** Repeated editing is slow and data loss risk is high.

**Recommendation:** Use fieldsets/sections with a sticky save bar, dirty-state indicator, unsaved-change warning, and error navigation. Consider save-and-continue rather than autosave for stock/pricing risk.

**Systemic fix:** Admin form shell and dirty-state behavior.

### [AD-10] Store settings combine unrelated, differently sensitive domains

**Severity:** P2  
**Area:** Admin / Settings  
**Affected routes:** `/admin/settings`  
**Evidence:** `admin_settings.png`; branding, hero, contact, bank, and SMTP in one form

**Problem:** Content editors and infrastructure configuration share one long save operation. SMTP secrets sit beside copy/image fields.

**Why it matters:** It increases accidental edits and makes permissions harder to scope.

**Recommendation:** Split Storefront content, Contact/legal identity, Payments/bank, and Email delivery into sections/tabs or routes. Show SMTP connection status and a separately authorized test action.

**Systemic fix:** Settings taxonomy and permission-aware sections.

### [AD-11] Manual order creation supports only one product line

**Severity:** P1  
**Area:** Admin / Orders  
**Affected routes:** `/admin/orders/new`  
**Evidence:** `admin_orders_new.png`; one product selector, one quantity, one unit price; `views/admin/order-form.ejs`

**Problem:** A manual order cannot contain multiple different products without creating separate orders.

**Why it matters:** It misrepresents real transactions, fragments customer history/PDFs, and complicates inventory and analytics.

**Recommendation:** Implement repeatable order lines with product/configuration, quantity, unit price, line discount, and running total; keep one order-level discount/payment/notes area.

**Systemic fix:** Manual order line-item editor using the same pricing/configuration model as cart.

### [AD-12] Manual orders default to “Paid”, which immediately affects stock

**Severity:** P1  
**Area:** Admin / Data integrity  
**Affected routes:** `/admin/orders/new`  
**Evidence:** Screenshot default “Payée”; helper says paid/processed decrements stock automatically

**Problem:** The highest-consequence status is preselected while the operator is still composing the order.

**Why it matters:** A hurried submit can decrement inventory and report revenue before payment is confirmed.

**Recommendation:** Default to Draft or Pending, present the stock/revenue consequence at final confirmation, and separate “Create order” from “Mark as paid” unless the user deliberately chooses the latter.

**Systemic fix:** Safe order-state defaults and consequence confirmation.

### [AD-13] Manual-order validation errors discard entered values

**Severity:** P1  
**Area:** Admin / Forms  
**Affected routes:** `/admin/orders/new`; settings has a similar redirect-on-error risk  
**Evidence:** `routes/admin-modules/orders.js:153-162` redirects to a fresh form; settings redirects after save error

**Problem:** Server validation failures set a flash then redirect without preserving the submitted form state.

**Why it matters:** Operators can lose a long order or configuration and must reconstruct it.

**Recommendation:** Re-render with sanitized submitted values and field-level errors, or store a short-lived safe form state. Product forms already demonstrate a partial re-render approach.

**Systemic fix:** Shared POST validation/render pattern.

### [AD-14] Order detail combines editable workflow, records, and communication without priority

**Severity:** P2  
**Area:** Admin / Order detail  
**Affected routes:** `/admin/orders/:id`  
**Evidence:** `admin_orders_43.png`; large editable form at left, stacked static cards at right, blank lower-right column

**Problem:** Status, payment, customer, addresses, documents, e-mail, fulfilment, and three note types are distributed across nested cards. Save is below all notes, even when changing only status.

**Why it matters:** Frequent tasks require scanning and long scrolling; related fulfilment controls are not grouped with delivery data.

**Recommendation:** Put status/payment/next action at top, group fulfilment and delivery, move notes to collapsible sections, keep a sticky save/action bar, and use the full width once the side column ends.

**Systemic fix:** Task-oriented OrderDetail layout.

### [AD-15] Order changes have no visible activity history

**Severity:** P1  
**Area:** Admin / Orders / Accountability  
**Affected routes:** `/admin/orders/:id`  
**Evidence:** Only created/updated timestamps are displayed; editable status/date/amount/notes have no timeline

**Problem:** Operators cannot see who changed status, adjusted received amount, sent an e-mail, or edited fulfilment notes.

**Why it matters:** Disputes and volunteer handoffs are hard to reconstruct; accidental changes are difficult to diagnose.

**Recommendation:** Record and display an immutable activity timeline for consequential changes and outbound communication, with actor and timestamp.

**Systemic fix:** Order audit-event model and Timeline component.

### [AD-16] Deleting an order is too available for a financial record

**Severity:** P1  
**Area:** Admin / Orders / Safety  
**Affected routes:** Order list and detail  
**Evidence:** “Supprimer” on every row and prominent detail-page button; confirmation says only irreversible

**Problem:** Paid/completed orders can be presented for direct deletion without explaining inventory, accounting, document, or analytics effects.

**Why it matters:** Permanent deletion can damage operational and financial history.

**Recommendation:** Prefer archive/void; restrict permanent deletion to exceptional draft/test orders and higher permission. Confirmation must summarize affected records and require explicit order-number acknowledgement where warranted.

**Systemic fix:** Order retention policy, permissions, and safe archival workflow.

### [AD-17] Categories can only be deleted, not deliberately created, renamed, merged, or ordered

**Severity:** P2  
**Area:** Admin / Categories  
**Affected routes:** `/admin/categories`, product form  
**Evidence:** `admin_categories.png`; new categories are implicitly created from free text in product form

**Problem:** Taxonomy management is an accidental side effect of product editing.

**Why it matters:** Typos and near-duplicates can fragment storefront filters; cleanup requires destructive removal from products.

**Recommendation:** Provide create, rename, merge, description, display order, and optional slug controls; product forms should select existing categories and explicitly offer “create”.

**Systemic fix:** Category entity management and controlled selector.

### [AD-18] Promo code fields do not make constraints or outcomes sufficiently concrete

**Severity:** P2  
**Area:** Admin / Promotions  
**Affected routes:** `/admin/promo-codes/new`, edit  
**Evidence:** `admin_promo-codes_new.png`; “10 ou 25.00”, native `mm/dd/yyyy`, active checkbox

**Problem:** Reduction value changes meaning by type, date format follows browser locale, and there is no live human-readable summary of the rule or conflict check.

**Why it matters:** Administrators can create a valid but unintended discount.

**Recommendation:** Add a unit suffix (`%`/`CHF`), locale-consistent date display, start/end validation, and a preview sentence such as “10% dès 50 CHF, du… au…, 100 utilisations”.

**Systemic fix:** Typed promo-rule editor and summary formatter.

### [AD-19] Analytics overemphasizes percentage changes from tiny samples

**Severity:** P2  
**Area:** Admin / Analytics  
**Affected routes:** `/admin/analytics`  
**Evidence:** `admin_analytics.png`: +166.7% average basket and -50% orders based on one paid order

**Problem:** Large red/green deltas imply significance without sample context; charts use one green series and the revenue chart lacks a visible value axis.

**Why it matters:** Volunteers may infer trends that the data cannot support.

**Recommendation:** Suppress or qualify deltas below a minimum sample, show absolute comparison values, add chart axis/tooltips or direct labels, and use semantic red only for genuinely adverse operational states.

**Systemic fix:** Analytics presentation rules with sample-size thresholds.

### [AD-20] Admin account and administrator management lack useful security context

**Severity:** P2  
**Area:** Admin / Account  
**Affected routes:** `/admin/account`, `/admin/admins`, administrator forms  
**Evidence:** Account screenshot; templates expose username/role/password only

**Problem:** There is no last login, active session indication, password visibility toggle, recent security event, or explanation of role capabilities.

**Why it matters:** Admins cannot verify account use or make informed role decisions.

**Recommendation:** Show last login/session/security metadata that the system can reliably support, describe roles, add password reveal/strength guidance, and keep destructive admin removal protected.

**Systemic fix:** Account-security presentation and role glossary.

## 9. Responsive and accessibility audit

### [AX-01] Confirmation modal does not manage focus as a modal dialog

**Severity:** P1  
**Area:** Accessibility / Interaction  
**Affected routes:** All destructive admin actions  
**Evidence:** `public/scripts/confirm-modal.js`: opens/close dialog but does not move focus, trap focus, mark background inert, or restore trigger focus

**Problem:** Keyboard focus remains behind the visible modal and can escape it.

**Why it matters:** Keyboard and screen-reader users may activate background controls or lose their place.

**Recommendation:** Focus the least destructive action on open, trap Tab within the dialog, make background inert, restore trigger focus on close, and preserve Escape/backdrop behavior.

**Systemic fix:** Accessible Dialog primitive.

### [AX-02] Focus indicators are not consistent across custom controls

**Severity:** P2  
**Area:** Accessibility / Global  
**Affected routes:** Checkout choices, menu toggle, standard fields/actions  
**Evidence:** Global blue 3 px focus ring; menu and choice controls override it with faint green 2 px outlines

**Problem:** The most complex custom controls receive a less visible focus treatment than native controls.

**Why it matters:** Keyboard position becomes hard to track on cream/green surfaces.

**Recommendation:** Use one high-contrast focus token, minimum 2 px with sufficient offset/contrast, across every interactive component.

**Systemic fix:** Focus-ring token and no local overrides without validation.

### [AX-03] Asynchronous catalogue updates are not announced

**Severity:** P2  
**Area:** Accessibility / Catalogue  
**Affected routes:** `/`  
**Evidence:** `public/scripts/catalogue.js` sets `aria-busy` and replaces the section but provides no result count/status live region

**Problem:** Filter changes update products in place and restore focus, but screen-reader users receive no outcome announcement.

**Why it matters:** They may not know that content changed or how many results remain.

**Recommendation:** Add a polite live status (“8 produits affichés”) and preserve/open filter state and focus as already attempted.

**Systemic fix:** Async-results status pattern.

### [AX-04] Important status differences sometimes rely primarily on color

**Severity:** P2  
**Area:** Accessibility / Admin analytics and statuses  
**Affected routes:** Analytics, order tables  
**Evidence:** Red/green comparison text and visually similar green status chips

**Problem:** Color carries positive/negative comparison and some state tone without icons or stronger textual framing.

**Why it matters:** Color-vision differences and low-quality displays reduce meaning.

**Recommendation:** Pair color with labels/icons/arrows and ensure status wording is always present. Do not use red for a neutral statistical decrease unless it is operationally negative.

**Systemic fix:** Status/comparison component semantics.

### [AX-05] Admin mobile navigation creates two separate collapsed menus

**Severity:** P2  
**Area:** Responsive / Admin  
**Affected routes:** All admin routes below 820 px  
**Evidence:** `responsive-admin-nav.css` separately collapses admin bar and public site navigation

**Problem:** Mobile admins must understand two hamburger controls in stacked header regions.

**Why it matters:** It duplicates navigation, consumes vertical space, and increases mode confusion.

**Recommendation:** In the dedicated admin shell, use one menu that includes admin destinations and a clear “View shop” escape action.

**Systemic fix:** Single responsive admin navigation.

### [AX-06] Responsive behavior is implemented but lacks demonstrated boundary coverage

**Severity:** P2  
**Area:** Responsive / Testing  
**Affected routes:** All  
**Evidence:** Breakpoints at 980/820/720/560 px across separate stylesheets; runtime caught overflow not visible in desktop screenshots

**Problem:** CSS includes thoughtful stacking/table-card rules, but shared viewport regressions survive. Long names, large prices, populated tables, open menus, validation, and provider embeds are not visibly covered.

**Why it matters:** Desktop screenshots give false confidence for the highest-risk responsive states.

**Recommendation:** Add a small Playwright visual/structural matrix at 360, 768, and desktop for home, product, cart, checkout, admin list/form/detail; assert no horizontal overflow and usable actions.

**Systemic fix:** Targeted responsive regression suite.

## 10. Screen-by-screen audit

### Storefront / homepage (`home.png`, `/`)

**What works:** Clear hero/catalogue separation, attractive warm palette, consistent product image containers, visible stock and prices, functional filter/sort controls, and a complete footer.  
**What does not:** The proposition is generic (SF-01), trust is late (SF-02/TR-01), random ordering and weak filters hinder discovery (SF-03/SF-04), cards lack decision facts (SF-05), and the empty review section actively signals weak adoption (SF-08). Four dense columns and uniform card surfaces create a competent but catalogue-template appearance rather than a curated refurbished shop.

### Product detail (`products_dell-latitude-e5570.png`, `/products/:slug`)

**What works:** Large gallery, prominent title/price, stock, 12-month warranty/30-day return copy, clear CTA, long description, and structured-looking specification rows.  
**What does not:** Condition is last in the table (PD-01), transaction facts and included accessories are missing near CTA (PD-02), no breadcrumb/alternatives exist (PD-03), description duplicates facts (PD-06), and specifications are only visually structured, not data-structured (PD-07). The page is credible but not optimized for refurbished-unit hesitation.

### Cart (`cart.png`, `/cart`)

**What works:** Empty state is unambiguous with one recovery action. The populated code path includes image, name, selected options, quantity, line price, totals, update, remove, and checkout.  
**What does not:** Empty layout is visually over-contained (VIS-03); populated mobile cart overflows and its item becomes very tall (CK-03/CK-05); delivery cost is deferred (CK-01); removal is visually neutral and immediate (CK-06).

### Checkout (code and runtime, `/checkout`)

**What works:** Guest checkout, pickup and delivery, billing-address reuse, several payment methods, promo code, live total calculation, and preserved checkout form state. Choice cards are easier to use than raw radio buttons.  
**What does not:** Mobile total is below the form (CK-02), the page overflows horizontally (CK-03), required/error presentation is incomplete (CK-04), unavailable payments are unexplained (CK-07), and the final action is ambiguous (CK-09). The one-page approach is appropriate, but it needs a visible summary and clearer sections rather than a multi-page redesign.

### Success / cancellation / 404 (code-only)

**What works:** Dedicated states, cart preservation on cancellation, provider-specific transfer/cash information, and clear recovery links.  
**What does not:** Success is a paragraph dump rather than a reassurance hierarchy (CK-10); bank details have no copy affordance; missing-order messaging is alarming without an immediately actionable support link. Flash/accessibility behavior applies (CK-11).

### Legal pages (`conditions-generales-de-vente.png`, `politique-confidentialite.png`, `remboursements-retours.png`)

**What works:** The content is real, specific to RecyTech, names seller/contact, describes 12-month warranty, 30-day commercial returns, Swiss-law caveat, payment providers, data categories, retention, and rights.  
**What does not:** No navigation/update metadata (TR-03), very heavy semibold prose and repetitive cards (TR-04), and policy claims are not linked from the product purchase area (TR-02). Privacy is the longest page and most needs a contents list and readable width.

### Admin dashboard (`admin.png`, `/admin`)

**What works:** At-a-glance inventory/revenue/order/review metrics, review moderation, direct product actions, and recent orders.  
**What does not:** Duplicate navigation, seven flat KPI cards, full inventory, and order table make an excessively long undifferentiated page (AD-01). Product notes distort rows (AD-03), product management lacks list tools (AD-02), and actions are unsafe/small (AD-04).

### Orders list (`admin_orders.png`, `/admin/orders`)

**What works:** Search, status filter, pagination, amount/received distinction, status chips, and create-order access.  
**What does not:** No date/provider sorting/filtering or bulk workflow (AD-05), identifiers wrap awkwardly, e-mail competes with names, and “Gérer”/“Supprimer” are small adjacent targets (AD-04/AD-16). A row click/open action and overflow menu would scan better.

### Order detail (`admin_orders_43.png`, `/admin/orders/:id`)

**What works:** Strong operational breadth: status/payment, received amount, customer, addresses, documents, contact, SMTP state, fulfilment, customer/internal notes, and ordered items.  
**What does not:** Task priority and grouping are weak (AD-14), changes have no timeline (AD-15), deletion is too available (AD-16), and terminology includes “fulfillment” (SYS-08). The long left column and short right column leave unusable blank space.

### Manual order (`admin_orders_new.png`, `/admin/orders/new`)

**What works:** Product/configuration-aware price hinting, received amount, promo/manual discount, internal notes, and stock consequence help.  
**What does not:** Only one line item (AD-11), paid default is risky (AD-12), errors lose work (AD-13), and product option selection is separated from a true order summary. This is a high-value workflow to redesign structurally.

### Analytics (`admin_analytics.png`, `/admin/analytics`)

**What works:** Period/provider filters, revenue/orders/basket/refunds/pending/discount KPIs, accessible SVG title/description, data-table disclosure, payment/status/delivery breakdowns, and top products.  
**What does not:** Tiny-sample deltas are visually authoritative and the sparse chart wastes space without a y-axis/value labels (AD-19). Date inputs appear in browser locale while surrounding text is French (SYS-08/AD-18 pattern).

### Product create and edit (`admin_products_new.png`, `admin_products_43_edit.png`)

**What works:** The same form serves create/edit, server errors preserve product input, private notes are clearly labeled, uploads are validated server-side, and publish/feature are explicit.  
**What does not:** Raw mini-languages (AD-06), irrelevant fields (AD-07), unusable media management (AD-08), no form sections/sticky save (AD-09), and free-form specifications (PD-07). Editing existing long text makes the density worse than the empty create state.

### Store settings (`admin_settings.png`, `/admin/settings`)

**What works:** Centralized shop identity, hero, contact, bank, and mail settings; helper text; password preservation behavior.  
**What does not:** Unrelated and sensitive domains share one 2,321 px form (AD-10), “hero” is internal design jargon exposed to administrators (SYS-08), media lacks preview (AD-08), and failure redirects can lose attempted values (AD-13).

### Promo codes (`admin_promo-codes.png`, `admin_promo-codes_new.png`)

**What works:** Clear empty state/creation CTA and support for percent/fixed value, order minimum, limit, validity window, description, active state.  
**What does not:** Empty list lacks feature explanation (VIS-03), rule entry is ambiguous and locale-inconsistent (AD-18), and there is no live rule preview or test-against-order facility.

### Categories (`admin_categories.png`, `/admin/categories`)

**What works:** Counts distinguish total and published products; deletion warns that it removes the category from products.  
**What does not:** The page is deletion-only and creation is an implicit side effect elsewhere (AD-17). The table does not expose storefront order or category descriptions.

### Account (`admin_account.png`, `/admin/account`)

**What works:** Username and password change are separated through current-password validation; helper text explains when the current password is required.  
**What does not:** Security context and password usability are minimal (AD-20). “Retour” does not say where it returns, an example of inconsistent navigation copy (SYS-08).

### Admin login, administrators, administrator form (code-only)

**What works:** Simple authentication form, role-aware access, 12-character password minimum, self/last-superadmin deletion protections.  
**What does not:** Login has no password reveal/recovery/support direction; administrator list/actions inherit table safety issues (AD-04); role meaning and security history are absent (AD-20). Runtime visual verification is still recommended for invalid-login, rate-limit, and mobile states.

## 11. Complete issue registry

| ID | Severity | Area | Route | Problem | Recommendation |
| --- | --- | --- | --- | --- | --- |
| SYS-01 | P1 | Global | All | Semibold display font used for all text | Use regular body face and semantic type scale |
| SYS-02 | P2 | Global | All | Component colors/states use ad-hoc rgba values | Add semantic interaction/status tokens |
| SYS-03 | P2 | Global | All | Cards, pills, borders, shadows overused | Define restrained surface/elevation rules |
| SYS-04 | P2 | Global | All | Weak hierarchy among text roles | Define display/body/supporting/numeric styles |
| SYS-05 | P1 | Actions | Cart/Admin | Destructive and routine action hierarchy unsafe | Canonical semantic action variants |
| SYS-06 | P3 | Icons | Global | Mixed icon sources/weights/sizes | Shared icon system |
| SYS-07 | P2 | Navigation | Admin | Duplicate admin/public navigation and page headers | Dedicated admin shell/header |
| SYS-08 | P2 | Copy | All | Terminology, capitalization, grammar inconsistent | French content guide and formatters |
| VIS-01 | P2 | Layout | Global | Same container/card treatment for all content | Content-specific layout primitives |
| VIS-02 | P2 | Imagery | Home/Product | Product image framing and proof inconsistent | Image policy and publication QA |
| VIS-03 | P3 | Empty states | Multiple | Oversized, unguided placeholder cards | Reusable action-oriented empty state |
| SF-01 | P1 | Homepage | `/` | Hero lacks strong differentiated proposition | Lead with tested refurbishment, impact, warranty |
| SF-02 | P1 | Trust | Home/Product/Cart | Trust and fulfilment information arrives late | Shared trust strip near decisions |
| SF-03 | P1 | Discovery | `/` | Filters do not match computer-buying needs | Typed attributes and high-value filters |
| SF-04 | P1 | Discovery | `/` | Random default ordering | Deterministic featured/newest ranking |
| SF-05 | P1 | Product cards | `/` | Cards omit condition and key specs | Canonical decision-rich ProductCard |
| SF-06 | P2 | Product cards | `/` | Names, prices, card hierarchy inconsistent | Content normalization and fixed card order |
| SF-07 | P2 | Search | `/` | Search hidden behind unlabeled visible icon | Visible search/filter affordance |
| SF-08 | P1 | Reviews | `/#reviews` | Empty social proof plus large form harms trust | Demote until reviews exist; collapse form |
| SF-09 | P2 | Reviews | `/#reviews` | Review credibility metadata absent | Dates and honest verification labels |
| PD-01 | P1 | Product | `/products/:slug` | Condition buried in spec table | Primary condition grade/report near price |
| PD-02 | P1 | Product | `/products/:slug` | Delivery, included items, payment absent near CTA | Purchase facts component |
| PD-03 | P2 | Product IA | `/products/:slug` | No breadcrumb/back/related products | Preserve catalogue context and alternatives |
| PD-04 | P1 | Product images | `/products/:slug` | Broken gallery renders blank block | Resilient shared image fallback |
| PD-05 | P2 | Mobile product | `/products/:slug` | Gallery dominates first viewport | Shorter mobile media composition |
| PD-06 | P2 | Product copy | `/products/:slug` | Repetitive prose and weak scan structure | Concise summary, bullets, structured facts |
| PD-07 | P1 | Product data | Product/Admin | Specifications are arbitrary free text | Typed category attribute schema |
| PD-08 | P3 | Product copy | `/products/:slug` | Generated grammar such as `1 unité(s)` | Plural-aware shared formatters |
| CK-01 | P1 | Cart | `/cart` | Delivery cost deferred | Show free pickup/shipping estimate in cart |
| CK-02 | P1 | Mobile checkout | `/checkout` | Total appears below ~2,388 px of form | Top collapsible/sticky summary |
| CK-03 | P1 | Responsive | Public journey | Horizontal overflow at 390 px | Fix shared shell/menu overflow and test |
| CK-04 | P1 | Checkout forms | `/checkout` | Required fields/errors not mapped to controls | Inline validation and error summary |
| CK-05 | P2 | Cart | `/cart` | Quantity update is bulky/manual | Progressive enhanced quantity control |
| CK-06 | P2 | Cart | `/cart` | Remove is neutral and immediate | Destructive quiet action plus undo/confirm |
| CK-07 | P2 | Payment | `/checkout` | Disabled payment methods unexplained | Hide or label reason/availability |
| CK-08 | P2 | Checkout | `/checkout` | Long flow lacks progress/review framing | Numbered sections and review moment |
| CK-09 | P1 | Checkout | `/checkout` | `Commander` is ambiguous | Payment-obligation-aware CTA copy |
| CK-10 | P2 | Post-purchase | Success/Cancel | Outcome pages lack reassurance hierarchy | Provider-specific next-step templates |
| CK-11 | P1 | Feedback/A11y | All forms | Flash is transient and not announced | Accessible persistent Notice/Toast |
| TR-01 | P1 | Trust | Home/Product | Association/refurbishment process absent | On-shop “Pourquoi RecyTech?” content |
| TR-02 | P1 | Trust/legal | Product/Legal | Warranty/returns claims lack linked detail | Anchored policy links near claim |
| TR-03 | P2 | Legal | Legal routes | No contents, updated date, direct actions | Legal metadata/navigation layout |
| TR-04 | P2 | Legal typography | Legal routes | Dense semibold wide prose | Regular text and readable width |
| TR-05 | P1 | Refurbished proof | Product | No unit-specific condition/test proof | Actual/representative labels and test report |
| AD-01 | P2 | Dashboard | `/admin` | Dashboard is a long inventory page | Focus on actions/exceptions; dedicated products |
| AD-02 | P1 | Products | `/admin` | No product list tools | Dedicated searchable/filterable list |
| AD-03 | P2 | Products | `/admin` | Private notes overwhelm rows | On-demand preview and better columns |
| AD-04 | P1 | Admin actions | Lists | Tiny crowded destructive row actions | Accessible row action menu |
| AD-05 | P2 | Admin tables | Multiple | No sorting; inconsistent statuses | Canonical sortable DataTable/status badges |
| AD-06 | P1 | Product form | Product create/edit | Fragile mini-languages | Structured builders and validation |
| AD-07 | P1 | Product form | Product create/edit | Irrelevant fields always visible | Conditional grouped sections |
| AD-08 | P1 | Media admin | Product/Settings | No image previews/order/remove | Reusable MediaManager |
| AD-09 | P1 | Admin forms | Product/Settings/Order | No sticky save/dirty protection | Admin form shell and unsaved warning |
| AD-10 | P2 | Settings | `/admin/settings` | Unrelated/sensitive settings mixed | Domain-based settings sections |
| AD-11 | P1 | Manual order | `/admin/orders/new` | Only one product line | Repeatable order line editor |
| AD-12 | P1 | Manual order | `/admin/orders/new` | Defaults to paid/stock decrement | Draft/pending safe default |
| AD-13 | P1 | Form resilience | Manual order/Settings | Validation redirects discard input | Re-render values with field errors |
| AD-14 | P2 | Order detail | `/admin/orders/:id` | Workflow/content priority weak | Task-oriented order layout |
| AD-15 | P1 | Order history | `/admin/orders/:id` | No activity/audit timeline | Immutable actor/timestamped events |
| AD-16 | P1 | Order safety | Orders | Permanent delete too available | Archive/void and restricted deletion |
| AD-17 | P2 | Categories | `/admin/categories` | Delete-only taxonomy management | Create/rename/merge/order categories |
| AD-18 | P2 | Promotions | Promo form | Rule units/date/outcome ambiguous | Typed inputs and live rule summary |
| AD-19 | P2 | Analytics | `/admin/analytics` | Tiny-sample deltas overstate significance | Thresholds, absolute context, chart labels |
| AD-20 | P2 | Admin security UX | Account/Admins | Role/login/security context missing | Role glossary and account security metadata |
| AX-01 | P1 | Accessibility | Confirm dialog | No focus move/trap/restore/inert background | Accessible Dialog primitive |
| AX-02 | P2 | Accessibility | Custom controls | Inconsistent faint focus rings | One validated focus token |
| AX-03 | P2 | Accessibility | Catalogue | Async results not announced | Live result-count status |
| AX-04 | P2 | Accessibility | Admin | Some meaning relies on color | Pair color with labels/icons |
| AX-05 | P2 | Responsive admin | Admin mobile | Two separate collapsed menus | One admin mobile menu |
| AX-06 | P2 | Responsive testing | All | Breakpoint edge states unverified | Small viewport regression matrix |

**Registry totals:** 70 findings — 0 P0, 33 P1, 34 P2, 3 P3.

## 12. Prioritized remediation roadmap

### Phase 1 — Critical UX and trust issues

1. Fix horizontal overflow and product-gallery failure behavior (CK-03, PD-04, PD-05).
2. Make checkout cost/validation/action explicit: mobile summary, shipping cost, field errors, accessible notices, payment-aware CTA (CK-01, CK-02, CK-04, CK-09, CK-11).
3. Put condition, included items, fulfilment, warranty/returns links, and refurbishment proof at the purchase decision (PD-01, PD-02, TR-01, TR-02, TR-05).
4. Correct admin safety/data-loss risks: draft manual-order default, preserve invalid submissions, restrict/replace order deletion, and fix modal focus (AD-12, AD-13, AD-16, AX-01).
5. Do not attempt a full visual redesign before these task and trust defects; they produce more value than cosmetic polish.

### Phase 2 — Design-system consolidation

1. Replace global semibold body typography and define the type scale (SYS-01/SYS-04/TR-04).
2. Define semantic colors, focus, action variants, statuses, surface/elevation rules, and spacing/layout primitives (SYS-02/SYS-03/SYS-05/AX-02).
3. Create canonical page header, field/error, notice, action, status badge, table/list, empty state, and dialog patterns.
4. Introduce one dedicated admin shell and one responsive navigation model (SYS-07/AX-05).
5. Establish the content glossary and numeric/date/quantity formatting rules (SYS-08/PD-08).

### Phase 3 — Major visual/UX improvements

1. Model typed product attributes and condition evidence; this unlocks better admin fields, cards, filters, and product pages (PD-07 before SF-03/SF-05/PD-01).
2. Redesign product media management and product form around structured sections/builders (AD-06/AD-07/AD-08/AD-09).
3. Create the dedicated product admin list and safer responsive row actions (AD-01–AD-05).
4. Add multi-line manual orders and task-oriented order detail with activity history (AD-11/AD-14/AD-15).
5. Recompose the homepage around proposition, curated discovery, trust, and conditional social proof (SF-01/SF-02/SF-04/SF-08).
6. Improve legal navigation/prose and post-purchase outcomes (TR-03/TR-04/CK-10).

### Phase 4 — Polish

1. Standardize imagery, product naming, icons, and card density (VIS-02/SF-06/SYS-06).
2. Refine promo rule preview, analytics small-sample behavior, category management, and account security context (AD-17–AD-20).
3. Improve empty states, async catalogue announcements, and payment availability copy (VIS-03/AX-03/CK-07).
4. Add the targeted responsive/visual regression matrix and test long names, broken images, empty/populated/error/loading states, open menus, and large values (AX-06).

### Dependencies and sequencing

- Typed product attributes and condition should precede advanced filters and richer product cards; otherwise the same free-form inconsistency will be duplicated in new UI.
- Semantic tokens and primitives should precede broad screen restyling, but they must not delay the Phase 1 overflow, checkout, fallback, and data-safety fixes.
- Multi-line manual orders require domain/persistence review before UI implementation because they affect totals, inventory, PDFs, and analytics.
- Order archive/history changes require retention and permission decisions before removing current delete behavior.
- Any final checkout-obligation wording should receive Swiss legal review; the UX requirement is clear even if the precise phrase needs counsel.

## Final answer: why a new visitor may hesitate or abandon

A completely new visitor may hesitate because RecyTech's most credible qualities are not proven where the purchase decision happens. The shop says equipment is tested and offers a warranty, but it does not foreground the association, refurbishment process, unit-specific condition, defects, battery/test evidence, included accessories, or whether photos show the actual unit. Catalogue cards provide too little technical information to compare computers, while the product page delays condition and omits delivery/pickup/payment expectations near the CTA. The empty review section visibly announces a lack of social proof. Legal information exists and is better than the storefront suggests, but it is dense and not linked directly from the claims it qualifies.

Customers may get confused because product naming/specifications are inconsistent, default sorting is random, search is visually hidden, condition and key specifications are not standardized, shipping cost is delayed, unavailable payment methods are unexplained, and “Commander” does not clearly describe the final consequence. On mobile they encounter a real horizontal scrollbar; the checkout total sits below the long form; and a failed product image can occupy most of the first screen as blank space. Those defects make the shop look less maintained than the underlying application actually is.

The largest improvement in perceived quality and usability would come from five coordinated changes: (1) fix mobile overflow and media fallbacks; (2) establish readable regular-weight typography and a restrained component hierarchy; (3) make condition, testing, included items, warranty, returns, and fulfilment primary product facts; (4) model key specifications so cards and filters support real comparison; and (5) keep the checkout total, required fields, errors, and payment consequence continuously clear. For administrators, the equivalent leap would come from a structured product editor, dedicated searchable product list, safe multi-line manual orders, and an order activity history. Together these changes would let the interface communicate the care that is already present in RecyTech's operational and legal implementation.
