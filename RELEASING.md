# Releasing

How a version of `tabby-better-sidebar-miller` reaches npm, why it needs no
one-time password, and what to check when it fails.

## TL;DR

```sh
npm version 1.0.17 --no-git-tag-version   # package.json + package-lock.json
# update CHANGELOG.md (## 1.0.17 (YYYY-MM-DD)) and README.md if the UI changed
npm run test:workspace-tabs && npm run lint:i18n && npm run build:prod
git add -A && git commit -m "feat(...): ..."
git tag -a v1.0.17 -m "1.0.17"            # tag must equal package.json version
git push origin master && git push origin v1.0.17
```

Pushing the `v*` tag is the release. GitHub Actions builds, tests, packs and
publishes to npm through OIDC: no npm password, no 2FA code, no token stored
in the repository. Verify a few minutes later:

```sh
npm view tabby-better-sidebar-miller version
npm view tabby-better-sidebar-miller dist-tags --json
```

Optionally add a GitHub Release page for the tag afterwards; it does not
trigger a second publication (the registry guard makes that a no-op).

Do **not** run `npm publish` locally: it fails with `EOTP` unless a one-time
password is supplied, and it cannot produce provenance. See the next section
for why.

## Why the local CLI asks for an OTP and CI does not

npm accounts with two-factor authentication set to "auth-and-writes" must
present a TOTP code on every write. That code proves a human is present, so
the npm CLI asks for it (`npm error code EOTP`). A CI job has no authenticator,
which is what **trusted publishing** replaces.

The replacement is a chain of short-lived, verifiable identities:

```
GitHub Actions job (workflow with `permissions: id-token: write`)
        │  requests an OIDC token from GitHub's token service
        ▼
GitHub-signed JWT   claims: repository, repository_owner,
                    workflow_ref (repo/.github/workflows/publish.yml@ref),
                    ref, environment, run id, ...      (lives ~minutes)
        │  npm CLI (>= 11.5) sees ACTIONS_ID_TOKEN_REQUEST_URL, calls
        ▼
https://registry.npmjs.org/-/npm/v1/oidc/token
        │  registry checks the JWT signature against GitHub's public keys
        │  and matches its claims with the package's stored trusted
        │  publisher entry (owner + repo + workflow filename + environment)
        ▼
short-lived npm publish token, scoped to this one publication,
2FA-exempt because the identity was proven by GitHub, not by a human
        │
        ▼
`npm publish` runs, and npm also records a provenance attestation
```

The package settings on npmjs.com (**Package → Settings → Trusted Publisher**)
hold the other half of that match: GitHub owner `miller806`, repository
`tabby-better-sidebar-miller`, workflow filename `publish.yml`, no environment.
Because the npm side stores the entry (with an `oidcConfigId`), GitHub needs no
npm secret at all — `NODE_AUTH_TOKEN` is never set, and publishing is denied to
every identity that is not that exact workflow in that exact repository.

Evidence that a publication went this way, straight from the registry:

```sh
npm view tabby-better-sidebar-miller@1.0.16 --json | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'))
  console.log(d._npmUser)          // { name: 'GitHub Actions', ... trustedPublisher }
  console.log(d.dist.attestations) // SLSA provenance for the tarball
"
```

`npm audit signatures` verifies the same attestation from a consumer's
machine: it ties an installed tarball back to this repository, commit, tag and
workflow file, so a tampered rebuild cannot pass as an official release.

## Workflow anatomy

`.github/workflows/publish.yml` has two jobs.

**`build`** runs on every push (branches and `v*` tags) and on pull requests:
`npm ci --ignore-scripts`, `test:workspace-tabs`, `lint:i18n`, `build:prod`,
`npm pack`, then uploads the resulting `.tgz` as an artifact. Nothing is
published here — a red build simply blocks the release.

**`publish`** runs only when the event is a GitHub Release, or a push of a
`v*` tag, and only after `build` succeeds:

1. `permissions: id-token: write` — the only privilege a trusted publication
   needs, and the reason OIDC works at all.
2. `npm install --global npm@11` — trusted publishing requires npm >= 11.5;
   the npm bundled with Node 24 is older.
3. **Check release version** — `v1.0.17` must equal `1.0.17` in
   `package.json`, otherwise the job stops. npm versions are effectively
   immutable (a version cannot be reused once published), so a tag that
   disagrees with the package would be an unfixable mistake.
4. **download-artifact** — the tarball produced by `build` is published as-is.
   Publishing the tested bytes, rather than rebuilding them, removes drift
   between what CI verified and what users install.
5. **Check registry for an already published version** — `npm view` decides
   whether the version is already on the registry; the publish step is
   skipped when it is. This makes re-pushed tags, retried runs and a GitHub
   Release created after the tag all harmless instead of a red run.
6. `npm publish <tarball> --access public --provenance` — the CLI performs the
   OIDC exchange, publishes, and attaches the SLSA v1 provenance.

Two notes that follow from this design:

- `prepublishOnly` (which runs `build:prod`) matters only for local publishes;
  in CI the tarball is packed by the `build` job and published from the file.
- Changing the workflow **filename** breaks publishing until the npm trusted
  publisher entry is updated to the new name. Editing the workflow body is
  safe; renaming it is not.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm error code EOTP` | Local publish with "auth-and-writes" 2FA | Publish from a tag push; or pass `--otp=<code>` locally |
| `Check release version` fails | Tag (`v1.0.16`) and `package.json` version disagree | Retag on the commit that bumps the version |
| `403 ... not authorized to publish over previously published version` | Version already on the registry | The registry guard should prevent this; verify the guard step ran |
| `404`/`401` on OIDC exchange | Trusted publisher missing or mismatched (owner, repo, workflow filename, environment) | Re-check **Package → Settings → Trusted Publisher** on npmjs.com |
| Publish step silently skipped | The registry already has that version | Expected; bump the version if a new release is intended |
| Build job red, publish job never starts | Tests, i18n lint or `build:prod` failed | Fix and push again; publishing waits on `build` |

## Changing or rotating the trusted publisher

All of it lives on npmjs.com, not in this repository:

1. https://www.npmjs.com/package/tabby-better-sidebar-miller/access →
   **Trusted Publisher**.
2. Update owner / repository / workflow filename / environment to match
   `.github/workflows/publish.yml` (environment must be empty unless the job
   declares `environment:`).
3. The next tag push publishes with the new configuration. Nothing to rotate
   in GitHub: there is no long-lived npm token in secrets.

Removing the trusted publisher entry takes publishing rights away from CI
immediately, leaving only local publication with a one-time password.

## Verifying a release

1. The Actions run for the tag: `build` and `publish` both green.
2. `npm view tabby-better-sidebar-miller version` — the new version.
3. `npm view tabby-better-sidebar-miller dist-tags --json` — `latest` points
   at it.
4. Contents: the tarball carries `dist/`, `CHANGELOG.md` and
   `THIRD-PARTY-NOTICES.md` only, with no source maps; `dist/index.js` contains
   the code that was just merged.
5. In Tabby: close it, then in the plugin directory
   (`%APPDATA%\tabby\plugins` on Windows) run
   `npm install tabby-better-sidebar-miller` and restart.
