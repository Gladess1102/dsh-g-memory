# Publishing to npm

The first publish of any version has to be done by a human with 2FA. Everything
after that goes through the `publish` workflow, which uses trusted publishing
(OIDC) and needs no token and no one-time code.

## First publish (once per package)

```sh
npm login          # browser flow; a passkey or authenticator both work
npm publish        # 2FA: the browser prompt is the normal path
```

**Do not use a recovery code as `--otp`.** npm treats recovery-code use as an
account-takeover signal: on 2026-11-12 this account was suspended for 72 hours
after exactly that, with publishing locked until the window expired. The browser
prompt (passkey / authenticator) is the only safe way to satisfy the one-time
password requirement from the CLI.

If npm refuses with `EOTP` and prints a `https://www.npmjs.com/auth/cli/...`
URL, open that URL — the passkey ceremony happens there and the CLI picks up the
result on its own.

## Trusted publishing (all later versions)

npm announced in July 2026 that 2FA-bypass granular access tokens lose the
ability to publish directly (expected around January 2027) and named trusted
publishing as the replacement. `.github/workflows/publish.yml` implements it:
the job requests an OIDC token, npm verifies the repository, workflow file and
branch from the package's own settings, and the publish is recorded with
provenance.

One-time setup, after the package exists. **There is no Trusted publishing form
in the package settings page** — the package page only carries access controls
(“Publishing access”, maintainers). The binding is created from the CLI:

```sh
npm trust github dsh-g-memory \
  --file publish.yml \
  --repo Gladess1102/dsh-g-memory \
  --allow-publish
```

That one command needs a browser 2FA tap, prints back the package, the workflow
file and the repository it resolved, and records `permissions: publish, stage
publish`. `npm trust list dsh-g-memory` shows it again (that read also asks for
2FA), and `npm trust revoke dsh-g-memory --id=<trust-id>` removes it.

Once the binding exists, the only step per release is:

- Cut a GitHub Release whose tag matches `package.json` (`v0.15.1` ↔ `0.15.1`).
  The workflow fails on a mismatch instead of burning a version number.

Optionally tighten “Publishing access” to *Require two-factor authentication and
disallow bypass 2fa tokens* — trusted publishers keep working at that setting,
and the long-lived bypass tokens stop being able to write at all.

## Verify a publish

```sh
npm view dsh-g-memory version dist.integrity
npm view dsh-g-memory versions --json | tail -5
```

Download counts are public and per-day, which is the only usage signal this
project has that is not a clone count:

```sh
curl -s https://api.npmjs.org/downloads/point/last-week/dsh-g-memory
```

## If the account is suspended

The email states the duration and the lift time (UTC). While suspended the
account is read-only: no publishing, no token creation, no package settings.
Trying again does not help and may extend the window.

After it lifts, in this order:

1. Regenerate recovery codes. They are **not** on the Account overview — that page
   only says "1 security key". They sit behind the 2FA settings screen:
   npmjs.com → Account → **Modify 2FA**. Any code used or exposed during the
   window should be considered burned.
2. `npm publish` with the browser 2FA prompt, or a GitHub Release once trusted
   publishing is bound.
3. Confirm 2FA covers writes again: a suspension can leave the account in
   *auth-only* mode, where the overview reads "Enabled for authorization only".
   Tighten it from the same **Modify 2FA** screen.

## History

| date | what happened |
|---|---|
| 2026-11-11 | account created, 2FA (security key) enabled the same hour |
| 2026-11-11 | `npm publish` with `--otp=<recovery code>` → 72 h suspension |
| 2026-11-14 16:39 UTC | suspension ends |
| 2026-11-17 | first publish of `0.15.0` from the CLI; the account came back in `auth-only` mode, so no one-time code was asked for |
| 2026-11-17 | `0.15.1` published by CI through `npm trust github`; the run took 21 s and recorded a signed provenance statement |
| 2026-11-17 | `0.0.0-stage` placeholder left by staged publishing removed with `npm unpublish` |
