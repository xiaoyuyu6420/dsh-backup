# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)

One-command backup **and restore** for DeepSeek Harness user data — sessions,
settings, credentials, skills, and plugin config under `~/.dsh`, excluding
reinstallable `node_modules` — with sha256 checksums, integrity verification,
automatic rotation, and scheduled auto-backup that survives restarts. Works on
macOS, Linux, and Windows.

## Commands

- **`/backup`** — immediately back up `~/.dsh` to `~/Desktop/dsh-backups/dsh-<timestamp>.tar.gz`
- **`/backup list`** — list existing backups (name + size) and auto-backup status
- **`/backup verify [prefix|all]`** — validate archive checksums (default: the newest)
- **`/backup restore <prefix|latest> [--dry-run]`** — restore `~/.dsh` from an archive
- **`/backup auto <N>|off|status`** — auto-backup every N hours (1–720; keeps 3 copies below 24h, 7 otherwise; persisted across restarts)
- **`/backup --keep N`** — override the rotation count (default 7)
- **`/backup github status|sync`** — GitHub sync status / push now
- **`backup_dsh` tool** — same capability for the model (`mode=backup|list|verify|restore|auto`)

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

Use a **private** repository — archives contain plaintext credentials. For an
`https` remote, set the token in the environment (`DSH_BACKUP_GITHUB_TOKEN` or
`GITHUB_TOKEN`); it is only written into the sync worktree's credential file
(never process args). Push is `HEAD:main --force-with-lease`; archives over
90 MB are skipped with a notice. State (last push, last error) lives in
`<destination>/auto.json` and shows in the panel and `/backup github status`.

## Settings panel (Web)

The same controls have a visual entry: a **Backup** tab inside Settings → Plugins
(`dsh web`). It shows the destination, auto-backup state, GitHub sync status, and
every archive with its size, and offers one-click back-up-now, per-archive
verify, download, and restore with a dry-run preview plus explicit confirmation.
Downloads stream from the loopback-only route `GET /backup-download/<name>`.
The tab talks to the host through the `backupPanel` Typert Remote namespace
(`/api` RPC); the browser bundle ships prebuilt in `lib/client.js` — no build
step at install time.

## How restore works

Restore is safe by construction:

1. The archive's sha256 is verified first — a corrupt archive never touches existing data.
2. Entries are listed and any path outside the backup root rejects the restore (tar path-traversal guard).
3. The current `~/.dsh` is snapshotted, then moved aside to `~/.dsh.pre-restore-<timestamp>` — restore replaces rather than merges.
4. The archive is extracted; restart `dsh` afterwards so restored sessions and settings take effect.

`--dry-run` shows the archive summary without writing anything.

## Configuration (optional)

Plugin `config` in the active cordis profile:

```yaml
- id: dsh-backup
  name: 'dsh-backup'
  config:
    destination: '~/Backups/dsh'   # default ~/Desktop/dsh-backups
    keep: 10                       # default rotation count
    exclude:                       # extra tar --exclude patterns
      - '*cache*'
    githubRepo: 'name/dsh-backups' # optional GitHub sync (see below)
```

Auto-backup state lives in `<destination>/auto.json` and resumes after restart.

## Security note

Backups contain plaintext credentials (`.credentials.yaml`, `qq-bridge/config.json`).
Archives and checksum sidecars are chmod 600 on POSIX (Windows relies on
per-user profile ACLs), but do **not** sync the backup directory to untrusted
locations, and treat archives as sensitive as your API keys.

Storage note: the plugin writes its own data (archives, checksum sidecars,
`auto.json`) directly through `node:fs`, the same pattern as DSH's own session
persistence — the `ctx.fs` capability is the model-facing sandboxed surface and
does not apply to host-owned storage.

## Install

```sh
dsh plugin --profile web add dsh-backup
```

Then restart `dsh web` (plugin discovery is cached per process) and run `/backup`,
or open Settings → Plugins → Backup.

## Requirements

- macOS, Linux, or Windows 10+ with `tar` in PATH (Windows ships bsdtar in
  System32; Git Bash's GNU tar also works — checksums prefer `sha256sum`/`shasum`
  and fall back to an in-process hash on Windows)
- DSH `0.1.0-rc.6` or compatible

## Development

Zero runtime dependencies — the host plugin is `lib/index.js`. The browser half
lives in `src/` and is bundled (zod inlined, React/Cordis external) into
`lib/client.js`, which is committed so git installs never build:

```sh
node scripts/build-client.mjs   # rebuild the client bundle after editing src/
node scripts/smoke.mjs          # host smoke suite (real temp dir, mocked DSH services)
node scripts/smoke-client.mjs   # client bundle: handshake, schemas, tab registration, SSR
```

## License

MIT
