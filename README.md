# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/@xiaoyuyu6420/dsh-backup)](https://www.npmjs.com/package/@xiaoyuyu6420/dsh-backup)
[![Downloads](https://img.shields.io/npm/dw/@xiaoyuyu6420/dsh-backup)](https://www.npmjs.com/package/@xiaoyuyu6420/dsh-backup)
[![Publish to npm](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml/badge.svg)](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh.md)

**Your entire DeepSeek Harness (DSH) workspace lives in one folder: `~/.dsh`. One failed upgrade, one accidental delete, one new laptop — without a backup, sessions, settings and skills are all gone. dsh-backup gives them back with one command.**

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup   # install
# restart dsh web, then type:
/backup                                                  # → a verified archive lands in ~/Desktop/dsh-backups/
```

Real output from a fresh v0.9.0 install:

```text
备份完成: dsh-20260826-195150036.tar.gz
sha256: 8f9ae6322ef782d21554981cf4547220d5bb3e64d7964a883317415ad54e3cbb
轮换删除 0 份（保留 7 份）
```

Prefer clicking? There's a visual panel in `dsh web` → Settings → Plugins → Backup: list, verify, restore, delete, edit settings — no restart.

![Backup panel](docs/assets/panel-backups.png)

## Why you want this

| Fear | What dsh-backup does about it |
|---|---|
| "An upgrade broke my setup" | Auto-takes a `dsh-pre-upgrade-` snapshot the moment the host version changes — try the new release, roll back if it bites |
| "I deleted / broke something" | `/backup restore latest --dry-run` previews exactly what comes back; a failed restore auto-rolls-back and shows a result receipt |
| "DSH won't even boot anymore" | Every backup drops a zero-dependency **rescue console** (`dsh-rescue` / `rescue.mjs`, or double-click「点我恢复」) next to the archives — a web UI that restores outside of DSH |
| "My API keys will end up in a cloud backup" | Credentials are redacted from archives by default; plaintext only ever lives in a local vault on your machine |
| "My session logs got corrupted" | `/backup doctor` scans and repairs session logs from a known-good backup; corrupt files are quarantined before they rotate away |
| "I got a new machine" | GitHub sync: `/backup github pull` fetches remote archives, `restore --sync-deps` reinstalls plugins |
| "Backups rot silently" | Every archive ships a sha256; `/backup verify all` checks integrity; daily/weekly tiered retention keeps useful history longer |
| "I'll forget to back up" | `/backup auto 12` — every 12 hours, survives restarts, rotates old copies (default keep 7) |

![Backup settings](docs/assets/panel-settings.png)

## Install

Requires macOS / Linux / Windows 10+ (ships `tar`) and DSH `0.1.1-rc.2` or compatible.

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup
# or straight from GitHub:
dsh plugin --profile web add github:xiaoyuyu6420/dsh-backup
```

Restart `dsh web` afterwards — the plugin only takes effect after a restart.

> The installer may print `✕ missing peer @deepseek-ai/...` warnings. These are
> expected: the peer packages are provided by the DSH host at runtime. As long
> as the command ends with `Done`, the plugin is installed.

## Quickstart

1. Install (above) and restart `dsh web`
2. Type `/backup`
3. Done — the archive lands in `~/Desktop/dsh-backups/`, timestamped, with a `.sha256` next to it

Want it on a schedule? `/backup auto 12` (every 12 hours; `off` stops it, `status` checks it).

## Command cheat sheet

| Task | Command |
|---|---|
| Back up now | `/backup` |
| Typed backup (selected types only) | `/backup --types skills,sessions` (types: `credentials`·`mcp`·`skills`·`sessions`·`settings`·`profiles`; `--only` works too) |
| Schedule (survives restarts) | `/backup auto 12` · `off` · `status` |
| Restore (preview first) | `/backup restore latest --dry-run` |
| Restore for real | `/backup restore latest` |
| Typed restore (merge, other types untouched) | `/backup restore <archive> --types skills` |
| List backups | `/backup list` |
| Verify integrity | `/backup verify [prefix\|all]` |
| Check & repair session logs | `/backup doctor` · `--repair [prefix\|latest]` |
| **Rescue when DSH won't boot** | double-click「点我恢复」in the backup dir, or `dsh-rescue` / `node rescue.mjs` |
| Delete / retention | `/backup delete <prefix\|latest>` · `/backup --keep N` (default 7) |

## Typed backup

Only need certain kinds of data? Use `--types` (or `--only`) to operate on a subset. Available types: `credentials` (API keys), `mcp` (MCP config), `skills`, `sessions`, `settings`, `profiles`.

- **Back up**: `/backup --types skills,sessions` creates a `dsh-t-` subset archive; rotation is tracked separately from full backups
- **Restore**: `/backup restore <archive> --types skills` merges only skills back into your existing `~/.dsh` (preview with `--dry-run`; overwritten files are kept aside as `.pre-merge-*`). Everything else stays untouched.
- **Credentials caveat**: `--types credentials` puts API keys into the archive **in plaintext** (full backups redact them). Such archives never go to GitHub sync — keep them local or copy them to a new machine yourself.
- **Guardrail**: restoring a typed archive without `--types` is rejected (prevents accidental data loss); the rescue channel likewise won't list or fully restore them.
- The Settings panel supports this too: check types under the backup button; typed archives get their own section.

## New machine

Prerequisite: GitHub sync was configured on the old one ([setup](docs/advanced.zh.md#github-同步可选), Chinese).

1. Install the plugin, set the same `githubRepo`
2. `/backup github pull` — fetch the remote backups
3. `/backup restore latest --sync-deps` — restore and reinstall plugin dependencies
4. Restart `dsh`

## FAQ

**Are my API keys / credentials inside the archive?**
No. Known credential files are redacted before archiving; the plaintext stays in a local vault that never leaves the machine. Restoring puts them back.

**What exactly gets backed up?**
Everything under `~/.dsh` — sessions, settings, skills, plugin config — minus your exclude patterns and `node_modules`.

**I messed up `~/.dsh` and now `dsh` won't start. Am I out of options?**
No — that's exactly what the rescue channel is for. Every backup writes `rescue.mjs` and a double-clickable launcher (`点我恢复.command` / `.bat` / `.sh`) into the backup directory. It runs on plain Node, no DSH required, and serves a local web UI to browse and restore archives.

**Windows support?**
Yes — Windows 10+ with the bundled `tar`. The rescue launcher becomes a `.bat` file.

**Where do backups go by default?**
`~/Desktop/dsh-backups/` — change it any time in the panel (Settings → Plugins → Backup) or via settings; takes effect immediately, no restart.

## Feedback

Tried it? Tell us what broke, what's missing, what you liked — it directly shapes the roadmap:

- 💬 [Share feedback (GitHub Discussions)](https://github.com/xiaoyuyu6420/dsh-backup/discussions)
- 🐛 [Report a bug](https://github.com/xiaoyuyu6420/dsh-backup/issues)

## What's new

<details>
<summary>Recent releases</summary>

- **0.11.0** — doctor container-contract check: the first zstd frame must decode to exactly one header line, byte-precise (non-empty, first newline at the last byte — aligned with the host reader). Single-frame rewrites, stray blank lines in the first frame, a missing trailing newline and skippable frames are now flagged corrupt (previously reported healthy while the host refused to load them); the rescue console checks in sync. Found via a community audit on deepseek-harness #1047.
- **0.10.0** — typed backups: back up just what you need (`/backup --types skills,sessions`) and merge-restore a subset (`/backup restore <archive> --types skills`); per-type archives rotate in their own bucket. Credential-type archives stay out of GitHub sync; cross-machine guardrails unchanged.
- **0.9.1** — feedback entry point in the panel; README overhaul. UX hardening from a six-agent review: restore-confirm button made visible again (missing theme fallback), snapshot self-deletion during snapshot-restore fixed, node discovery for the double-click rescue launcher, friendlier error messages with concrete next steps.
- **0.9.0** — `/backup doctor` session-log health check with targeted repair; out-of-process rescue channel (`dsh-rescue` / launcher in the backup dir) that works even when the host won't boot; restore auto-rollback with a result-oriented receipt; smart backup: pre-upgrade snapshots on host train changes, quarantine of corrupt session logs before they rotate away, tiered daily/weekly retention.
- **0.8.0** — edit backup settings right in the panel (destination, retention, exclude patterns), saved instantly to `settings.yaml`, no restart; stale edits get a conflict warning instead of silent overwrite.
- **0.7.x** — credential redaction with a local vault; cross-machine restore.

</details>

## More

Retention policy, credential redaction internals, GitHub sync, restore safeguards, config reference, troubleshooting, and development notes — in the [advanced guide](docs/advanced.zh.md) (Chinese). Cross-runtime compatibility notes: [compatibility.md](docs/compatibility.md).

## Acknowledgements

- [@beastrobin](https://github.com/beastrobin) — the reserved-method-name root cause analysis in #1 that directly led to the v0.5.1 fix
- [@mlosun](https://github.com/mlosun) — the thorough reproduction and root cause report in #2
- [@Choi-Peng](https://github.com/Choi-Peng) — triage help pointing affected users to the fix in #5

## License

MIT
