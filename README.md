# dsh-backup

[![dsh-plugin](https://img.shields.io/badge/ecosystem-dsh--plugin-8b5cf6)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/@xiaoyuyu6420/dsh-backup)](https://www.npmjs.com/package/@xiaoyuyu6420/dsh-backup)
[![Publish to npm](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml/badge.svg)](https://github.com/xiaoyuyu6420/dsh-backup/actions/workflows/publish.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh.md)

**dsh-backup is a DeepSeek Harness (DSH) plugin that backs up and restores `~/.dsh` with a single command.**

Everything you have in DSH — sessions, settings, skills, and plugin config — lives in one folder: `~/.dsh`. Delete it by accident, break a config, or move to a new machine: with a backup, you get it all back.

What you get:

- **One command to back up, one to restore** — every archive ships with a checksum so you can tell if it's corrupted, and old backups rotate out automatically.
- **Scheduled backups** — set an interval and forget it. It keeps the schedule across restarts.
- **Credentials never enter an archive** — plaintext stays in a local `vault/` folder and is restored automatically (details below).
- **New machine, no panic** — backups sync to your private GitHub repo; pull them down on the new machine and restore.
- **A web panel** — prefer clicking? There's a visual UI for everything.

Works on macOS, Linux, and Windows.

## Install

```sh
dsh plugin --profile web add @xiaoyuyu6420/dsh-backup
# or from GitHub:
dsh plugin --profile web add github:xiaoyuyu6420/dsh-backup
```

Then restart `dsh web`.

## Quickstart

About 30 seconds:

1. Install (above) and restart `dsh web`
2. Run `/backup`
3. Done — the archive lands in `~/Desktop/dsh-backups/`, named with a timestamp

That one command covers day-to-day use. Want it to run on a schedule? See below.

## Scenario cheat sheet

| Situation | What to do |
|---|---|
| Routine backup | `/backup` (or "Back up now" in the panel) |
| Afraid you'll forget | `/backup auto 12` — every 12 hours, keeps going across restarts |
| Broke a config or a plugin install | `/backup restore latest --dry-run` to preview, then drop the flag to do it |
| `~/.dsh` is gone entirely | `/backup restore latest` |
| New machine | See "New machine" below |
| Suspect a corrupt archive | `/backup verify all` |
| Keep a copy in the cloud | `/backup github repo name/dsh-backups` — every backup pushes from then on (use a private repo) |

## Commands

| Command | What it does |
|---|---|
| `/backup` | Back up now |
| `/backup list` | List backups (name, size) and the auto-backup status |
| `/backup verify [prefix\|all]` | Check that archives are intact (default: newest only) |
| `/backup restore <prefix\|latest>` | Restore; `--dry-run` previews, `--sync-deps` reinstalls plugin dependencies afterwards |
| `/backup auto <hours>\|off\|status` | Start / stop / check scheduled backups |
| `/backup --keep N` | Override how many copies to keep (default 7) |
| `/backup github …` | Cloud sync — see "GitHub sync" |
| `/backup delete <prefix\|latest>` | Delete a backup and its sidecar files |

The model can call the same operations directly via the `backup_dsh` tool (`mode=backup|list|verify|restore|auto`; restore accepts `syncDeps`).

## Scheduled backups

```
/backup auto 12
```

From then on, a backup runs every 12 hours (any interval from 1 to 720).

- `/backup auto off` — stop
- `/backup auto status` — check

State lives in `auto.json` inside the backup folder. After a restart, the schedule resumes from the last run instead of restarting the clock. Retention: intervals under 24 hours keep 3 copies by default, longer ones keep 7 (override with `config.keep`).

## New machine

Prerequisite: the old machine had GitHub sync configured (next section).

1. Install the plugin on the new machine and set the same `githubRepo`
2. `/backup github pull` — fetches every remote backup (each one checksum-verified; corrupt copies are skipped and reported)
3. `/backup restore latest --sync-deps` — restore, then reinstall plugin dependencies per profile
4. Restart `dsh`

The restore report tells you two things: the backup came from another machine (watch for absolute paths in configs), and which credential files you need to re-enter (they're not in the archive — see next section). To save a step, `/backup github pull --restore latest` restores right after pulling.

## Credentials (passwords, tokens)

Files like `.credentials.yaml`, `.env`, and `qq-bridge/config.json` never enter an archive, by default:

- On backup: plaintext copies go into a `vault/` folder under the backup directory, locked to your user (mode 700/600). The archive and the GitHub sync carry only redacted copies.
- Restoring on the same machine: credentials are copied back from the vault automatically.
- Restoring on a new machine: there's no vault, so the report lists the missing files — re-enter them once.
- To change the list, edit `config.redact`; `redact: false` turns the whole mechanism off (not recommended — that's the pre-v0.7 plaintext behavior).

Each archive also carries two small metadata files: `.meta.json` (which machine, which home directory, when) and `.redacted.json` (what was redacted). Restore preflight reads them and warns about cross-machine restores.

Archives and checksum files are chmod 600 on macOS/Linux; Windows relies on per-user profile ACLs.

## GitHub sync (optional)

Set `githubRepo` in the plugin config, and every backup (manual, scheduled, or from the panel) is pushed to that Git repository. Deletions sync too:

```yaml
- id: dsh-backup
  name: 'dsh-backup'
  config:
    githubRepo: 'your-name/dsh-backups'   # owner/repo, a full URL, or a local path
```

Things to know:

- **Use a private repository.** Archives carry no plaintext credentials, but they do contain your session content.
- For https remotes, provide a token via `DSH_BACKUP_GITHUB_TOKEN` or `GITHUB_TOKEN`. It's written only to the sync worktree's credential file, never into process args.
- The push is `HEAD:main --force-with-lease` — the remote's main is aligned with your local backup folder, so don't put anything else in that repo.
- Archives over 90 MB are skipped from sync, with a notice.
- Sync state (last push, last error) shows in `/backup github status` and the panel; `/backup github sync` pushes immediately instead of waiting for the next backup.

## Web panel

Open **Settings → Plugins → Backup** in `dsh web`: see every archive with its size, the auto-backup and sync status, and run back-up-now, per-archive verify, **download**, restore (dry-run preview plus confirmation), and **pull from GitHub** (the first step of a new-machine restore). Downloads go through a loopback-only route, never exposed externally.

## How restore works

Restore touches your live data, so every step is guarded:

1. **Verify first**: a corrupt archive aborts the restore before anything is touched.
2. **Path check**: any entry escaping the backup root (tar path traversal) rejects the restore.
3. **Preflight**: a backup from another machine/home triggers an absolute-path warning; redacted archives explain that credentials come back from the local vault (or must be re-entered, cross-machine).
4. **Keep an escape hatch**: the current `~/.dsh` is snapshotted, then moved aside to `~/.dsh.pre-restore-<timestamp>`. Restore replaces rather than merges, so stale files can't linger. If `~/.dsh` no longer exists (data lost, or first restore on a new machine), extraction proceeds directly.
5. **Extract**: the archive is unpacked; credentials return from the vault; `--sync-deps` runs `pnpm install` per profile (node_modules never travel inside archives).
6. **Restart `dsh`** and the restored sessions and settings take effect.

`--dry-run` shows the summary and preflight hints without writing anything. When in doubt, dry-run first.

## Configuration (optional)

Defaults work out of the box. To adjust, add `config` to the plugin in your active cordis profile:

```yaml
- id: dsh-backup
  name: 'dsh-backup'
  config:
    destination: '~/Backups/dsh'   # where backups go (default ~/Desktop/dsh-backups)
    keep: 10                       # copies to keep for manual backups (default 7); also applies to scheduled ones when set
    exclude:                       # extra tar --exclude patterns
      - '*cache*'
    redact:                        # extra credential files (relative to ~/.dsh); false/'off' disables redaction
      - 'some-plugin/token.json'
    githubRepo: 'name/dsh-backups' # GitHub sync (optional)
```

## Requirements

- macOS, Linux, or Windows 10+, with `tar` in PATH (Windows ships it)
- Checksums prefer `sha256sum`/`shasum` and fall back to a built-in hash when absent (that's the norm on Windows)
- DSH `0.1.0-rc.6` or compatible

## Troubleshooting

- **Installed the wrong package** — the correct one is `@xiaoyuyu6420/dsh-backup` (scoped). The unscoped `dsh-backup` on npm is an unrelated third-party package. Check your profile's plugin list and reinstall with the scoped name.
- **Plugin fails to load with `client api: method "backupPanel/remove" conflicts with its namespace service`** — you're on v0.5.0 (see [#2](https://github.com/xiaoyuyu6420/dsh-backup/issues/2), [#5](https://github.com/xiaoyuyu6420/dsh-backup/issues/5)). Fixed in v0.5.1: run `dsh plugin --profile web add @xiaoyuyu6420/dsh-backup@latest` to upgrade, then restart `dsh web`.
- **Which `tar` on Windows?** Either. System32 ships bsdtar and Git Bash provides GNU tar; verification works in both shells.

## Development

Zero runtime dependencies — the host plugin is `lib/index.js`. The browser half lives in `src/` and its bundle (`lib/client.js`, zod inlined, React/Cordis external) is committed, so git installs never build. The panel talks to the host through the `backupPanel` namespace (`/api` RPC); downloads use the loopback-only route `GET /backup-download/<name>`.

Storage note: the plugin writes its own data (archives, checksum sidecars, `auto.json`, `vault/`) directly through `node:fs`, the same pattern as DSH's own session persistence — `ctx.fs` is the model-facing sandboxed surface and doesn't apply to host-owned storage.

```sh
node scripts/build-client.mjs   # rebuild the client bundle after editing src/
node scripts/smoke.mjs          # host smoke suite (real temp dir, mocked DSH services)
node scripts/smoke-client.mjs   # client bundle smoke: handshake, schemas, tab registration, SSR
```

## Acknowledgements

- [@beastrobin](https://github.com/beastrobin) — the reserved-method-name root cause analysis in #1 that directly led to the v0.5.1 fix
- [@mlosun](https://github.com/mlosun) — the thorough reproduction and root cause report in #2
- [@Choi-Peng](https://github.com/Choi-Peng) — triage help pointing affected users to the fix in #5

## License

MIT
