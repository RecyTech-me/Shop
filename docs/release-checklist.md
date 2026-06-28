# Release Checklist

Before deployment:

- `git status --short` is clean.
- Changes are reviewed in a commit or pull request.
- `npm ci` completed.
- `npm run verify` passed.
- `npm run coverage:check` passed.
- `npm audit --audit-level=moderate` passed.
- Secret scan passed in CI.
- Migration notes were reviewed.
- SQLite backup completed.
- Backup verification drill succeeded for the selected backup when relevant.
- Rollback/restore path is known.

During deployment:

- Deploy workflow finishes successfully.
- Service restart completes.
- `/healthz` returns `status: ok`.
- Failed health checks alert through `ALERT_WEBHOOK_URL`.

After deployment:

- Check application logs for startup, migration, and reservation cleanup errors.
- Confirm payment webhooks are reachable from Stripe and Swiss Bitcoin Pay dashboards.
- Confirm order notification email behavior if SMTP settings changed.
