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

One-time setup, after the package exists:

1. npmjs.com → Packages → `dsh-g-memory` → Settings → **Trusted publishing**
2. Add a GitHub Actions publisher:

   | field | value |
   |---|---|
   | organization/user | `Gladess1102` |
   | repository | `dsh-g-memory` |
   | workflow | `publish.yml` |
   | environment | *(empty)* |

3. Cut a GitHub Release whose tag matches `package.json` (`v0.15.1` ↔ `0.15.1`).
   The workflow fails on a mismatch instead of burning a version number.

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

1. Regenerate recovery codes (npmjs.com → Account → Manage Recovery Codes), since
   any code used or exposed during the window should be considered burned.
2. `npm publish` with the browser 2FA prompt, or a GitHub Release once trusted
   publishing is bound.
3. Confirm `Require two-factor authentication for write actions` is back on.

## History

| date | what happened |
|---|---|
| 2026-11-11 | account created, 2FA (security key) enabled the same hour |
| 2026-11-11 | `npm publish` with `--otp=<recovery code>` → 72 h suspension |
| 2026-11-14 16:39 UTC | suspension ends |
