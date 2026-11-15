# Application security audit — 15 November 2026

Scope: public WebSite and Shop source, complete reachable Git history, npm lockfiles,
Actions workflows, and a small set of anonymous production HTTP requests. Tests use
local fixtures; no customer data, real payment, SMTP send, or production brute-force
attempt was used. Host OS, Hestia privileges, firewall, Cloudflare account settings,
and full server runtime inventory could not be inspected with the available access. Deployment logs report Node 24.18.0; its security patch level needs an administrator review/update.
This is a point-in-time assessment, not proof that no vulnerabilities exist.

## Findings and changes

| Finding | Evidence / impact | Resolution |
| --- | --- | --- |
| Stored DOM XSS on WebSite (medium; requires product-write access or a hostile API response) | A product description inserted into a detached `div.innerHTML` loaded an image and executed its error handler in a local Chromium reproduction. HTML escaping afterwards was too late. | Parse in an inert template, validate URL schemes/origins, add a strict website CSP, and run browser regression tests without relying on CSP. |
| Private PDFs in public Git history (high for confidentiality) | Five committee/AG PDFs were tracked on Shop and in historical/renamed WebSite directories. Login on a deployed route does not protect GitHub copies. | Move production files to ignored server storage, verify migration before promotion, remove tracked copies, then purge all affected paths from every writable branch/tag in both repos. Public statutes are explicitly preserved. GitHub PR refs/caches require separate handling. |
| Old WooCommerce credentials in WebSite history (potentially high if still active) | An additional credential-format rule found four historical matches (a key and secret in two commits); default Gitleaks rules did not detect them. The current app does not use these credentials. Validity was not tested. | Remove their values during history purge; retain detection for future occurrences. Revoke the old keys at the former WooCommerce installation if they remain active. History rewriting cannot revoke a key or recall downloaded copies. |
| Personalized HTML has no explicit cache restriction (medium) | Production login responses lacked Cache-Control. Shop templates contain CSRF tokens, carts, admin or customer state. | All dynamic responses default to `private, no-store`. Public product JSON explicitly retains its short public cache; static assets retain their own policy. |
| Multipart resource limits weaker than ordinary forms (low/medium; requires admin session) | Multipart text fields used default 1 MB with no field/part count limit; image conversion ran before CSRF rejection. | Bound fields, parts, names, text and files; defer conversion until CSRF validation; cap decoded image pixels; read only the image signature bytes instead of the whole file. |
| FTP deployment did not require encryption (medium) | The website workflow omitted protocol; the action defaults to FTP. | Require strict FTPS and certificate verification. Upgrade checkout/deploy actions and pin immutable commits; limit token permissions and serialize releases. No insecure fallback. |
| Exposed deployment metadata / missing website security headers (low / defense in depth) | Production `/.ftp-deploy-sync-state.json` returned 200 and website HTML lacked CSP/nosniff/framing restrictions. | Deny hidden files and backup formats, disable directory listings, add security headers. Validate under Apache and verify again on production because a front proxy can bypass `.htaccess`. |
| Payment-provider rate-limit reset via fresh sessions (medium) | Stripe intent quotas were keyed by IP plus session; opening a new session reset the same IP’s quota. | Key intent quotas by IP independently of session and regression-test different session IDs. |
| Production session security depended on proxy detection (defense in depth) | Session Secure used `auto`; the app itself accepted plain HTTP independently of its configured HTTPS origin. | Require Secure cookies in production and reject insecure writes/redirect insecure reads using Express's configured proxy trust. Host-only cookies are intentionally retained. |

## Dependency and tooling review

The initial and updated npm audits report zero known advisories in either production
or development dependencies. This is an advisory-database result, not a guarantee.
Compatible updates in Shop's lockfile include Express 5.3.0, express-session 1.19.0,
Multer 2.5.0, Nodemailer 10.5.0, Sharp 0.35.5, better-sqlite3 13.2.0,
compression 1.8.2, Stripe 22.6.2, Playwright 1.65.1 and globals 17.14.0.
ESLint is upgraded from unsupported 9.x to tested 10.15.0 (@eslint/js 10.0.1).
EJS 7, dotenv 18 and Stripe 23 are deferred major migrations: no advisory requires
them and a breaking API/template/environment change is a separate compatibility task.

Semgrep ran 70 Node/Express/JavaScript rules against 109 tracked source targets,
with approximately 100% of selected lines parsed. Six alerts were reviewed:
five static cookie-configuration heuristics and a direct-response warning for a
PDF Buffer with PDF content headers. The missing Domain flag is intentional
(host-only is safer); maxAge already bounds lifetime; the default path was `/`.
A default cookie name is fingerprinting, not an authentication bypass. The Secure
and HTTPS behavior is hardened and regression-tested. No exploitable SQL injection,
command execution, auth bypass, or webhook signature bypass was confirmed in the
reviewed code. SQL values are parameterized; remaining dynamic identifiers are
internal constants. This does not certify all possible paths or runtime inputs.

## Validation

- 275 Shop tests pass; coverage 89.84% lines, 74.43% branches, 90.56% functions; syntax, ESLint and npm audit pass.
- HTTP regressions: CSRF, Host validation, private cache behavior, trusted-proxy
  handling, oversized multipart fields, existing admin flows, document access,
  revocation/logout, path traversal and private-file static-path bypasses.
- Synthetic document migration: complete copy, repeatability, SHA-256 conflict
  rejection, preserved existing files, and failure when a required file is missing.
- Website browser tests reproduce the prior XSS and verify inert descriptions,
  escaped titles and rejected JavaScript/data/off-site navigation URLs.
- Apache 2.4.69: syntax and live checks of `.htaccess`, blocked metadata/backup
  paths, public statutes, old bookmark redirects; Chromium smoke test with actual
  CSP returns 200, hides the loader and reports no console errors.
- Gitleaks over 126 Shop and 196 WebSite commits before purge; custom WooCommerce
  matching supplements the default rule set. New findings are not globally ignored.

## Outstanding operator items / limits

1. Revoke historical WooCommerce keys if still active. Repository removal does not
   establish whether an external WooCommerce installation accepted them.
2. Ask GitHub Support to purge retained PR refs, cached views and unreachable
   sensitive objects after history rewriting; existing clones/downloads cannot be
   recalled. There were no GitHub forks reported when checked.
3. Update collaborators' clones after rewritten history; do not merge old clones
   back into cleaned branches. Audit successful writes to every remote branch/tag.
4. Check production header/metadata behavior after deploy and configure the front
   proxy as well if it serves files without consulting Apache.
5. Server OS/Node security patch level, SSH configuration, backup restore/access,
   Hestia/Cloudflare privileges and MFA still need authenticated infrastructure
   review. Admin MFA is not implemented; current login uses scrypt, CSRF, rate
   limits, session regeneration and auth-version revocation.
6. `dev.shop.recytech.me` still needs an authoritative DNS record; Hestia's web
   domain entry alone does not publish a Cloudflare DNS record.
