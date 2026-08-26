# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/@xiaoyuyu6420/dsh-backup)](https://www.npmjs.com/package/@xiaoyuyu6420/dsh-backup)
[![Publish to npm](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml/badge.svg)](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh.md)

**dsh-backup is a DeepSeek Harness (DSH) plugin that backs up and restores `~/.dsh` with a single command.**

Sessions, settings, skills, and plugin config all live in `~/.dsh`. Delete it by accident, break a config, or move to a new machine — with a backup, you get it all back. Credentials never enter an archive; scheduled backups and GitHub sync are supported (details in the [advanced guide](docs/advanced.zh.md), Chinese).

Recent additions: **0.8.0** can edit backup settings right in the panel (destination, retention, exclude patterns) — saved instantly to `settings.yaml`, no restart; stale edits get a conflict warning instead of being silently overwritten. **0.7.x** added credential redaction with a local vault and cross-machine restore.

## Install

The package is published on [npm](https://www.npmjs.com/package/@xiaoyuyu6420/dsh-backup); install it into a DSH profile with:

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup
# or from GitHub:
dsh plugin --profile web add github:xiaoyuyu6420/dsh-backup
```

Then restart `dsh web`. Requires macOS / Linux / Windows 10+ (ships `tar`) and DSH `0.1.1-rc.2` or compatible.

## Quickstart

1. Install (above) and restart `dsh web`
2. Run `/backup`
3. Done — the archive lands in `~/Desktop/dsh-backups/`, named with a timestamp

Want it on a schedule? `/backup auto 12` — every 12 hours, keeps going across restarts.

## Commands

| Task | Command |
|---|---|
| Back up now | `/backup` |
| Schedule | `/backup auto 12` (`off` to stop, `status` to check) |
| Restore | `/backup restore latest` (`--dry-run` to preview) |
| List backups | `/backup list` |
| Verify integrity | `/backup verify [prefix\|all]` |
| Check & repair session logs | `/backup doctor` (`--repair [prefix\|latest]` to fix from a backup) |
| **Total failure rescue** | double-click `点我恢复` in the backup dir, or `node rescue.mjs` — a zero-dependency recovery console (web UI) that works even when DSH won't boot |
| Delete | `/backup delete <prefix\|latest>` |
| Keep N copies (default 7) | `/backup --keep N` |

There's a visual panel in `dsh web` → Settings → Plugins → Backup: it lists backups, runs verify/restore/delete, and — since 0.8.0 — edits the backup settings (destination, retention, exclude patterns) directly, applied immediately, no restart.

## New machine

Prerequisite: GitHub sync was configured on the old one ([setup](docs/advanced.zh.md#github-同步可选)).

1. Install the plugin, set the same `githubRepo`
2. `/backup github pull` — fetch the remote backups
3. `/backup restore latest --sync-deps` — restore and reinstall plugin dependencies
4. Restart `dsh`

## More

Retention policy, credential redaction, GitHub sync, restore safeguards, config reference, troubleshooting, and development notes — in the [advanced guide](docs/advanced.zh.md) (Chinese).

## Acknowledgements

- [@beastrobin](https://github.com/beastrobin) — the reserved-method-name root cause analysis in #1 that directly led to the v0.5.1 fix
- [@mlosun](https://github.com/mlosun) — the thorough reproduction and root cause report in #2
- [@Choi-Peng](https://github.com/Choi-Peng) — triage help pointing affected users to the fix in #5

## License

MIT
