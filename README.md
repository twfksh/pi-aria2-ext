# pi-aria2-ext

Lightweight, resumable downloads for [Pi](https://github.com/earendil-works/pi), powered by a private [aria2](https://aria2.github.io/) daemon.

It gives the agent a compact `download` tool and gives you an interactive downloads dashboard, a compact footer status, and a `/download` shortcut. No runtime dependencies beyond Pi itself and the `aria2c` binary.

```text
↓ Downloads  3.4 MiB/s · 2 active · 1 paused
  ●  78% ██████████░░  ubuntu-24.04.iso    4.2/5.4 GiB  1.2 MiB/s  1m12s
  ‖  31% ██████░░░░░░  model.bin           1.1/3.5 GiB  paused
```

## Why this instead of a wrapper script

- **One private daemon per session.** Loopback-only RPC on a random port with a 256-bit secret.
- **The secret is not in `ps`.** It lives in a `0600` config file inside a `0700` directory, not in argv.
- **No orphans.** `--stop-with-process` makes aria2 exit if Pi crashes.
- **Never overwrites, never deletes.** `rm` and `purge` only change the queue; partial and finished files stay on disk.
- **Survives restarts.** Jobs are persisted per working directory and restored *paused*, so a restart never starts network traffic you did not ask for.
- **Zero runtime dependencies.** The RPC client is a small `fetch`-based JSON-RPC implementation; no WebSocket library, no Pix packages.
- **Better UX.** Progress bars, ETA, a full-screen downloads dashboard, completion notifications, `wait`, `retry`, `info`, and `stats`.

## Requirements

- Pi 1.4 or newer.
- `aria2c` 1.36 or newer on `PATH` (or at `~/.pi/agent/bin/aria2c`, or pointed to by `PI_ARIA2_BIN`).

Install aria2 with your package manager:

```bash
# Debian / Ubuntu
sudo apt install aria2

# Fedora
sudo dnf install aria2

# macOS
brew install aria2

# Windows
winget install aria2.aria2
```

## Install

From a local checkout:

```bash
cd pi-aria2-ext
bun install
pi install /absolute/path/to/pi-aria2-ext
```

Or load it for one run:

```bash
pi -e ./src/index.ts
```

Once published, `pi install npm:pi-aria2-ext` works the same way.

## Quick start

Ask the agent:

> Download https://example.com/archive.iso to ~/Downloads and wait for it.

Or do it yourself:

```text
/download https://example.com/archive.iso ~/Downloads
# Ctrl+Shift+O toggles the downloads dashboard
```

The agent can also call the tool directly:

```ts
download({ action: "add", url: "https://example.com/archive.iso", dir: "~/Downloads" });
download({ action: "wait", handle: "dl-brisk-otter-42" });
```

## The `download` tool

| Action   | Input                                          | Result                                              |
| -------- | ---------------------------------------------- | --------------------------------------------------- |
| `add`    | `url`, `dir`, `out`, `connections`, `maxSpeed` | Queues one download per URL, one `dl-*` handle each |
| `list`   | optional `filter`                              | Grouped progress rows with handles                  |
| `info`   | `handle`                                       | File path, URL, size, speed, ETA, error             |
| `pause`  | `handle` (one, many, a gid, or `"all"`)        | Pauses live downloads                               |
| `resume` | same as `pause`                                | Resumes paused downloads                            |
| `rm`     | same as `pause`                                | Removes from the queue. **Files are kept.**         |
| `retry`  | `handle` or `"all"`                            | Re-adds failed downloads                            |
| `purge`  | none                                           | Clears finished/failed entries. **Files are kept.** |
| `wait`   | optional `handle`, `timeoutSec`                | Blocks until they finish, then lets go              |
| `stats`  | none                                           | Daemon version, speed, counts, directories          |

Notes:

- `add`: `url` is a string or an array, and `paused` queues without starting. An array queues **independent downloads**, one per URL — not a mirror list.
- `out` is a plain file name, not a path, and is only valid when adding one URL.
- `connections` is clamped to 1–16. `maxSpeed` accepts `"5M"`, `"500K"`, or bytes/second.
- `list` filters: `all`, `active`, `waiting`, `paused`, `done`, `failed`.
- `wait` keeps the downloads running after `timeoutSec` (1–3600, default 300) expires.
- `handle` accepts the short `dl-*` handle, an aria2 gid, `"all"`, or an array.
- `wait` on a paused download returns immediately with a clear "nothing to wait for" message instead of blocking until the timeout.
- `wait` on an already-finished download reports it as already finished.
- The tool is `sequential`, because all calls share the same queue.

## Interactive UI

### Downloads dashboard

`Ctrl+Shift+O` replaces the prompt editor with a focused dashboard. Every line hangs off a left rail, the way the prompt itself is framed, and the rail turns accent-coloured for the selected download so the selection reads at a glance without an extra marker column. Rows are one line each, and the selected download expands in place with its path, size, elapsed time, live speed while it is active, and the error reason when it failed. The prompt is hidden while the dashboard is open, so keystrokes drive the dashboard instead of the editor.

```text
┃ Downloads · 1 active · 1 done · 1 failed
┃
┃ ✗ Zap-x86_64.AppImage               failed · 0 B
┃ ✓ ZAP_2.17.0_Linux.tar.gz           100% ████████  411 MiB
┃      Path    ~/Download/Zap/ZAP_2.17.0_Linux.tar.gz
┃      URL     github.com/zaproxy/…/ZAP-x64.AppImage
┃      Size    411 MiB / 411 MiB
┃      Elapsed 5m 0s
┃      Handle  dl-brisk-marten-15
┃ ● ubuntu-24.04.iso                   24%  ██░░░░░░  2.3 MiB/s · 114 MiB
┃
┃ ↑↓ move · ⏎ details · p pause/resume · R retry · d remove · esc close
```

| Key                    | Action                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `↑` / `↓`              | Select the previous/next download, wrapping at both ends                               |
| `Enter`                | Expand or collapse the selected download's details                                     |
| `p`                    | Pause or resume the selected download                                                  |
| `R`                    | Retry the selected failed download                                                     |
| `d`                    | Remove it (press twice; files stay on disk)                                            |
| `Esc` / `Ctrl+Shift+O` | Close and restore the prompt                                                           |

Movement is one row per physical key press: Kitty-protocol key-release events are ignored, so a press is never applied twice, and holding a key still repeats normally.

Use the `download` tool for filtering or other queue operations.


### `/download`

`/download <url> [dir]` adds a download without a model round trip. With no arguments it opens an input dialog.

## Safety model

This extension is designed to be boringly safe for a coding agent:

- **Loopback RPC only.** `rpc-listen-all=false`, and the client refuses any endpoint that is not `http://127.0.0.1:<port>/jsonrpc`.
- **Secret handling.** A random 256-bit secret is written to a `0600` file inside a `0700` runtime directory and deleted on shutdown. It is never passed on the command line and never appears in logs or tool output.
- **No orphan daemons.** `--stop-with-process=<pi pid>` ties the daemon to the Pi process. If Pi is killed, aria2 exits.
- **No shell.** The binary is spawned with an argv array.
- **URL allowlist.** Only `http`, `https`, `ftp`, `sftp`, and `magnet` URLs are accepted. `file:`, `data:`, `javascript:`, and other schemes are rejected.
- **Never overwrite.** `continue=true`, `allow-overwrite=false`, and `auto-file-renaming=false`. An existing destination is an error, not a silent replacement.
- **Never delete.** `rm`, `purge`, and `remove` only manipulate aria2's queue. Downloaded files and `.aria2` control files are left untouched.
- **No path traversal from `out`.** `out` must be a single file name; separators, `..`, control characters, and `.aria2` suffixes are rejected.
- **Optional write confinement.** Set `allowedRoot` and every download directory must resolve inside it.
- **Bounded state.** URLs, sizes, and paths are written `0600` so interrupted downloads can be restored. Delete `~/.pi/agent/pi-aria2/` to forget everything.
- **No secret leakage in the transcript.** Displayed and stored tool-result URLs drop the query string and userinfo. (The model's original tool-call arguments are still recorded by Pi, as with any tool.)

### BitTorrent

Magnet links work through aria2's BitTorrent support. DHT is **off** by default because it opens a UDP port; magnet links therefore need trackers unless you enable it. aria2 also opens one random TCP listen port for BitTorrent. `seed-time=0` stops seeding as soon as the download completes, and local peer discovery is disabled.

## Configuration

Create `~/.pi/agent/pi-aria2/config.json` (all fields optional):

```json
{
  "defaultDir": "~/Downloads",
  "split": 8,
  "maxConcurrent": 5,
  "maxSpeed": "10M",
  "notifyOnComplete": true,
  "persist": true,
  "stopWithPi": true,
  "allowedRoot": "~/Downloads",
  "pollIntervalMs": 800,
  "enableDht": false
}
```

| Field              | Default | Meaning                                                                          |
| ------------------ | ------- | -------------------------------------------------------------------------------- |
| `defaultDir`       | `"."`   | Directory used when a download names no `dir`; relative to Pi's cwd              |
| `split`            | `8`     | Connections per file, 1–16                                                       |
| `maxConcurrent`    | `5`     | Simultaneous downloads, 1–20                                                     |
| `maxSpeed`         | unset   | Global cap such as `"10M"`                                                       |
| `notifyOnComplete` | `true`  | Toast on completion/failure                                                      |
| `persist`          | `true`  | Save job intent across restarts                                                  |
| `stopWithPi`       | `true`  | Tie the daemon lifetime to Pi                                                    |
| `allowedRoot`      | unset   | Confine download directories                                                     |
| `pollIntervalMs`   | `800`   | Poll interval while active, 250–5000                                             |
| `enableDht`        | `false` | Enable BitTorrent DHT (opens a UDP port)                                         |

### Environment variables

| Variable                  | Effect                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `PI_ARIA2_BIN`            | Explicit path to `aria2c`                                                           |
| `PI_ARIA2_HOME`           | State/runtime directory (default `~/.pi/agent/pi-aria2`)                            |
| `PI_ARIA2_DIR`            | Override `defaultDir`                                                               |
| `PI_ARIA2_SPLIT`          | Override `split`                                                                    |
| `PI_ARIA2_MAX_CONCURRENT` | Override `maxConcurrent`                                                            |
| `PI_ARIA2_MAX_SPEED`      | Override `maxSpeed`                                                                 |
| `PI_ARIA2_NOTIFY`         | `0` / `1`                                                                           |
| `PI_ARIA2_NO_PERSIST`     | `1` disables persistence                                                            |
| `PI_ARIA2_KEEP_DAEMON`    | `1` lets the daemon outlive Pi (not recommended)                                    |
| `PI_ARIA2_ALLOWED_ROOT`   | Override `allowedRoot`                                                              |
| `PI_ARIA2_POLL_MS`        | Override `pollIntervalMs`                                                           |
| `PI_ARIA2_DHT`            | `1` enables DHT                                                                     |

## Cross-session behavior

- Job intent is stored per working directory in `~/.pi/agent/pi-aria2/jobs-<hash>.json` with mode `0600`.
- On restart, interrupted downloads are re-added to the new daemon **paused**, keeping their handles and partial files. Resume when you are ready.
- A download whose data file is already complete (size matches, no `.aria2` control file) is recognized as complete instead of failing with "file already exists".
- Finished and failed entries remain visible until `purge`.
- Current download progress (bytes, speed) is not persisted; it is re-read from aria2 after resume.
- Two Pi processes in the same working directory share the same state file. Avoid running two managers in the same directory at once.

## Scope and limitations

Supported: direct HTTP/HTTPS, FTP, SFTP, magnet/torrent, segmented multi-connection downloads, resume via `.aria2` control files, redirects, and aria2's built-in retry.

Not supported: extracting media URLs from web pages, HLS/DASH, YouTube, DRM, authentication cookies, custom request headers, transcoding, and playback. Use `yt-dlp` or `ffmpeg` for those.

The extension does not delete files. If a download fails with "file already exists", remove or rename the existing file yourself and use `retry`.

## Development

```bash
bun install
bun test          # 88 tests, including real aria2 integration tests
bun run typecheck
pi -e ./src/index.ts
```

The test suite starts real `aria2c` processes and a local range-capable HTTP server; tests that need aria2 are skipped when it is not installed.

### Layout

| File               | Responsibility                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `src/index.ts`     | Extension registration, tool surface, commands, renderers                                  |
| `src/manager.ts`   | Queue state, polling, persistence coordination, chrome updates                             |
| `src/daemon.ts`    | Private aria2 process lifecycle and hardened config                                        |
| `src/rpc.ts`       | `fetch`-based aria2 JSON-RPC client                                                        |
| `src/store.ts`     | Atomic `0600` job persistence                                                              |
| `src/validate.ts`  | URL, path, speed, and handle validation                                                    |
| `src/present.ts`   | Pure text formatting for tool results                                                      |
| `src/dashboard.ts` | Focused dashboard that replaces the prompt editor                                          |
| `src/config.ts`    | `config.json` plus environment overrides                                                   |

## License

MIT.
