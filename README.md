# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/@xiaoyuyu6420/dsh-backup)](https://www.npmjs.com/package/@xiaoyuyu6420/dsh-backup)
[![Publish to npm](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml/badge.svg)](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh.md)

One-command backup **and restore** for DeepSeek Harness user data — sessions,
settings, credentials, skills, and plugin config under `~/.dsh`, excluding
reinstallable `node_modules` — with sha256 checksums, integrity verification,
automatic rotation, and scheduled auto-backup that survives restarts.
**Credentials are redacted by default**: plaintext never enters an archive or
the GitHub sync, only a local vault, and is restored automatically. Cross-machine
restores get preflight hints and a one-command `github pull`. Works on macOS,
Linux, and Windows.

## Scenario cheat sheet

| Scenario | What to run |
|---|---|
| Everyday backup | `/backup` (or Settings → Plugins → Backup → Back up now) |
| Don't trust yourself to remember | `/backup auto 12` — scheduled, survives restarts |
| Broke a config / bad plugin install | `/backup restore latest --dry-run`, then drop the flag |
| `~/.dsh` is gone entirely | `/backup restore latest` — no existing data means no snapshot, straight to restore |
| New machine | Install the plugin, set the same `githubRepo` → `/backup github pull` → `/backup restore latest --sync-deps` |
| Suspect a corrupt archive | `/backup verify all` |
| Cloud copy | `/backup github repo name/dsh-backups` (private repo); every backup pushes afterwards |

## Commands

- **`/backup`** — immediately back up `~/.dsh` to `~/Desktop/dsh-backups/dsh-<timestamp>.tar.gz`
- **`/backup list`** — list existing backups (name + size) and auto-backup status
- **`/backup verify [prefix|all]`** — validate archive checksums (default: the newest)
- **`/backup restore <prefix|latest> [--dry-run] [--sync-deps]`** — restore `~/.dsh` from an archive (`--sync-deps` reinstalls per-profile plugin dependencies afterwards)
- **`/backup auto <N>|off|status`** — auto-backup every N hours (1–720; retains 3 copies below 24h, 7 otherwise, unless `config.keep` overrides; persisted across restarts)
- **`/backup --keep N`** — override the rotation count (default 7)
- **`/backup github status|sync|pull [--restore <prefix|latest>]|repo <address|off>`** — sync status / push now / pull backups from the repo / set the sync repository
- **`/backup delete|rm <prefix|latest>`** — delete a backup and its sidecars
- **`backup_dsh` tool** — same capability for the model (`mode=backup|list|verify|restore|auto`; restore accepts `syncDeps`)

## Credential redaction & the local vault

Credential files (by default `.credentials.yaml`, `.env`, `qq-bridge/config.json`;
extend or disable via `config.redact`) **never enter an archive**:

- On backup, plaintext copies are mirrored into `vault/` under the backup
  directory (POSIX mode 700/600); archives and the GitHub sync carry only
  redacted data.
- Restoring on the same machine copies the credentials back from the vault —
  full fidelity.
- Restoring on a new machine (no vault) lists the missing credential files and
  tells you to re-enter them.
- Each archive ships with `.redacted.json` (the redaction list) and
  `.meta.json` (host / home / timestamp) sidecars; restore preflight uses them
  to flag cross-machine path risks and credentials to re-enter.
- `config.redact: false` restores the v0.6.x plaintext behavior (not recommended).

## GitHub sync

With `config.githubRepo` set, every backup (manual, automatic, or panel) is
also pushed to a Git repository — archives, checksum sidecars, and rotation
deletions stay in sync:

```yaml
- id: dsh-backup
  name: 'dsh-backup'
  config:
    githubRepo: 'your-name/dsh-backups'   # owner/repo, full URL, or a local path
```

Use a **private** repository — archives are redacted but still contain session
content. For an `https` remote, set the token in the environment
(`DSH_BACKUP_GITHUB_TOKEN` or `GITHUB_TOKEN`); it is only written into the sync
worktree's credential file (never process args). Push is `HEAD:main
--force-with-lease`; archives over 90 MB are skipped with a notice. State (last
push, last error) lives in `<destination>/auto.json` and shows in the panel and
`/backup github status`.

**Restoring on a new machine**: install the plugin, configure the same
`githubRepo`, then run `/backup github pull` — it fetches every remote backup
(each one sha256-verified; corrupt archives are skipped and reported), then
`/backup restore latest --sync-deps` restores and reinstalls plugin
dependencies. The restore report reads `.meta.json` to flag the cross-machine
restore (absolute-path risks) and lists the credentials to re-enter.
`--restore <prefix|latest>` restores a specific archive right after pulling.

## Settings panel (Web)

The same controls have a visual entry: a **Backup** tab inside Settings → Plugins
(`dsh web`). It shows the destination, auto-backup state, GitHub sync status, and
every archive with its size, and offers one-click back-up-now, per-archive
verify, download, restore with a dry-run preview plus explicit confirmation,
and **pull from GitHub** (the first step of a new-machine restore).
Downloads stream from the loopback-only route `GET /backup-download/<name>`.
The tab talks to the host through the `backupPanel` Typert Remote namespace
(`/api` RPC); the browser bundle ships prebuilt in `lib/client.js` — no build
step at install time.

## How restore works

Restore is safe by construction:

1. The archive's sha256 is verified first — a corrupt archive never touches existing data.
2. Entries are listed and any path outside the backup root rejects the restore (tar path-traversal guard).
3. Preflight: `.meta.json` flags a backup from another machine/home (absolute-path risks); redacted archives note that credentials come back from the local vault (or must be re-entered cross-machine).
4. The current `~/.dsh` is snapshotted, then moved aside to `~/.dsh.pre-restore-<timestamp>` — restore replaces rather than merges. A missing `~/.dsh` (data gone / first restore on a new machine) skips the snapshot and extracts directly.
5. The archive is extracted; redacted archives then restore credentials from the vault; `--sync-deps` runs `pnpm install` per profile (node_modules never travel inside archives).
6. Restart `dsh` afterwards so restored sessions and settings take effect.

`--dry-run` shows the archive summary and preflight hints without writing anything.

## Configuration (optional)

Plugin `config` in the active cordis profile:

```yaml
- id: dsh-backup
  name: 'dsh-backup'
  config:
    destination: '~/Backups/dsh'   # default ~/Desktop/dsh-backups
    keep: 10                       # manual rotation count (default 7); when set, also the auto-backup retention — auto keeps 3 copies below 24h, 7 otherwise by default
    exclude:                       # extra tar --exclude patterns
      - '*cache*'
    redact:                        # extra redacted files (relative to ~/.dsh); false/'off' disables redaction
      - 'some-plugin/token.json'
    githubRepo: 'name/dsh-backups' # optional GitHub sync (see below)
```

Auto-backup state lives in `<destination>/auto.json` and resumes after restart — the next run is scheduled from the last auto-backup time, never reset by the restart.

## Security note

Credential files are redacted by default (see above): archives and the GitHub
sync carry no plaintext credentials — plaintext lives only in the local
`vault/` under the backup directory (POSIX 700/600). Archives may still contain
sensitive session content, so keep the sync repository private. Archives and
checksum sidecars are chmod 600 on POSIX (Windows relies on per-user profile
ACLs).

Storage note: the plugin writes its own data (archives, checksum sidecars,
`auto.json`, `vault/`) directly through `node:fs`, the same pattern as DSH's
own session persistence — the `ctx.fs` capability is the model-facing sandboxed
surface and does not apply to host-owned storage.

## Install

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup
# or from git:
dsh plugin --profile web add github:xiaoyuyu6420/dsh-backup
```

> ⚠️ The npm package name is the **scoped** `@xiaoyuyu6420/dsh-backup`. The
> unscoped `dsh-backup` on npm is an unrelated third-party package — don't
> install it.

## Quickstart

Your first backup is about 30 seconds away:

1. Install the plugin — `dsh plugin --profile web add @xiaoyuyu6420/dsh-backup`
2. Restart `dsh web` — plugin discovery is cached per process.
3. Run `/backup` — the archive and its sha256 sidecar land in `~/Desktop/dsh-backups/`.

Prefer clicking? The same flow lives in Settings → Plugins → Backup.

## Requirements

- macOS, Linux, or Windows 10+ with `tar` in PATH (Windows ships bsdtar in
  System32; Git Bash's GNU tar also works — checksums prefer `sha256sum`/`shasum`
  and fall back to an in-process hash on Windows)
- DSH `0.1.0-rc.6` or compatible

## Troubleshooting

- **Plugin fails to load with `client api: method "backupPanel/remove" conflicts with its namespace service`** — you are on v0.5.0, whose delete-endpoint method name collided with a reserved name in the DSH client (issues [#2](https://github.com/xiaoyuyu6420/dsh-backup/issues/2), [#5](https://github.com/xiaoyuyu6420/dsh-backup/issues/5)). v0.5.1 renamed the method to `removeEntry`; upgrade with `dsh plugin --profile web add @xiaoyuyu6420/dsh-backup@latest` and restart `dsh web`.
- **Which `tar` on Windows?** Either one works — Windows ships bsdtar in System32, and Git Bash provides GNU tar. Checksums prefer `sha256sum`/`shasum` when present and fall back to an in-process hash, so `/backup verify` works in both shells.
- **Installed the wrong package** — the npm package is the **scoped** `@xiaoyuyu6420/dsh-backup`; the unscoped `dsh-backup` is an unrelated third-party package. Check your profile's plugin list and reinstall with the scoped name.

## Development

Zero runtime dependencies — the host plugin is `lib/index.js`. The browser half
lives in `src/` and is bundled (zod inlined, React/Cordis external) into
`lib/client.js`, which is committed so git installs never build:

```sh
node scripts/build-client.mjs   # rebuild the client bundle after editing src/
node scripts/smoke.mjs          # host smoke suite (real temp dir, mocked DSH services)
node scripts/smoke-client.mjs   # client bundle: handshake, schemas, tab registration, SSR
```

## Acknowledgements

- [@beastrobin](https://github.com/beastrobin) — the reserved-method-name root
  cause analysis in #1 that directly led to the v0.5.1 fix
- [@mlosun](https://github.com/mlosun) — the thorough reproduction and root
  cause report in #2
- [@Choi-Peng](https://github.com/Choi-Peng) — triage help pointing affected
  users to the fix in #5

## License

MIT
