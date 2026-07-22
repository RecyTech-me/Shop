# Release Checklist

Before deployment:

- `git status --short` is clean.
- Changes are reviewed in a commit or pull request.
- `npm ci` completed.
- `npm run verify` passed.
- `npm run coverage:check` passed.
- `npm audit --audit-level=moderate` passed.
- Secret scan passed in CI.
- The checksum-verified Gitleaks history scan passed, and any `.gitleaksignore` entry still refers only to a reviewed test fixture.
- `SHOP_PUBLIC_URL` or `BASE_URL` is the public HTTPS canonical production origin.
- `DEPLOY_KNOWN_HOSTS` matches the production server key obtained through a trusted channel.
- `dev` resolves only to `shopsite-dev`/`dev.shop.recytech.me`, and `main` resolves only to `shopsite`/`shop.recytech.me`.
- Development and production still use separate environment files, databases, uploads, staging directories, and rollback snapshots.
- Migration notes were reviewed.
- SQLite backup completed.
- SQLite backup integrity check passed.
- Backup verification drill succeeded for the selected backup when relevant.
- Rollback/restore path is known.

During deployment:

- Deploy workflow finishes successfully.
- Service restart completes.
- `/healthz` returns `status: ok`.
- Failed health checks alert through `ALERT_WEBHOOK_URL`.
- A failed restart or health check restores the preceding application release when one exists.

After deployment:

- Check application logs for startup, migration, and reservation cleanup errors.
- Confirm payment webhooks are reachable from Stripe and Swiss Bitcoin Pay dashboards.
- Confirm order notification email behavior if SMTP settings changed.
