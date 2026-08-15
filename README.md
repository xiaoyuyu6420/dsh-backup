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
- **`backup_dsh` tool** — same capability for the model (`mode=backup|list|verify|restore|auto`)

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
```

Auto-backup state lives in `<destination>/auto.json` and resumes after restart.

## Security note

Backups contain plaintext credentials (`.credentials.yaml`, `qq-bridge/config.json`).
Archives and checksum sidecars are chmod 600 on POSIX (Windows relies on
per-user profile ACLs), but do **not** sync the backup directory to untrusted
locations, and treat archives as sensitive as your API keys.

## Install

```sh
dsh plugin --profile web add dsh-backup
```

Then restart `dsh web` and run `/backup`.

## Requirements

- macOS, Linux, or Windows 10+ with `tar` in PATH (Windows ships bsdtar in
  System32; Git Bash's GNU tar also works — checksums prefer `sha256sum`/`shasum`
  and fall back to an in-process hash on Windows)
- DSH `0.1.0-rc.6` or compatible

## Development

Zero dependencies, no build step — the plugin is `lib/index.js`. Run the
cross-platform smoke suite (real temp dir, mocked DSH services):

```sh
node scripts/smoke.mjs
```

## License

MIT
