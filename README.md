# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)

One-command backup for DeepSeek Harness user data — sessions, settings,
credentials, skills, and plugin config under `~/.dsh`, excluding reinstallable
`node_modules` — with sha256 checksums, automatic rotation, and scheduled
auto-backup.

## Features

- **`/backup`** — immediately back up `~/.dsh` to `~/Desktop/dsh-backups/dsh-<timestamp>.tar.gz`
- **`/backup list`** — list existing backups and auto-backup status
- **`/backup auto <N>`** — auto-backup every N hours (1–720; keeps 3 copies below 24h, 7 otherwise)
- **`/backup auto` / `/backup auto off`** — query status / disable
- **`/backup --keep N`** — override the rotation count (default 7)
- **`backup_dsh` tool** — same capability for the model (`mode=backup|list|auto`)

Every backup writes a sidecar `*.sha256` checksum file. Rotation deletes the
oldest archives beyond the keep count.

## Install

```sh
dsh plugin --profile web add dsh-backup
```

Then restart `dsh web` and run `/backup`.

## Requirements

- macOS or Linux with `tar` in PATH (checksum prefers `sha256sum`, falls back to `shasum` on macOS)
- DSH `0.1.0-rc.6` or compatible

## License

MIT
