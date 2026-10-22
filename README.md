<!-- markdownlint-disable MD033 -- tables are HTML so they span the full width -->

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
- **Out of the agent's way.** `add` hands the URLs to the daemon and returns; the agent turn ends and downloads keep streaming. Polling is a timer, not a blocking call.
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

<table width="100%">
  <thead>
    <tr>
      <th align="left">Action</th>
      <th align="left">Input</th>
      <th align="left">Result</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>add</code></td>
      <td><code>url</code>, <code>dir</code>, <code>out</code>, <code>connections</code>, <code>maxSpeed</code></td>
      <td>Queues one download per URL, one <code>dl-*</code> handle each</td>
    </tr>
    <tr>
      <td><code>list</code></td>
      <td>optional <code>filter</code></td>
      <td>Grouped progress rows with handles</td>
    </tr>
    <tr>
      <td><code>info</code></td>
      <td><code>handle</code></td>
      <td>File path, URL, size, speed, ETA, error</td>
    </tr>
    <tr>
      <td><code>pause</code></td>
      <td><code>handle</code> (one, many, a gid, or <code>"all"</code>)</td>
      <td>Pauses live downloads</td>
    </tr>
    <tr>
      <td><code>resume</code></td>
      <td>same as <code>pause</code></td>
      <td>Resumes paused downloads</td>
    </tr>
    <tr>
      <td><code>rm</code></td>
      <td>same as <code>pause</code></td>
      <td>Removes from the queue. <strong>Files are kept.</strong></td>
    </tr>
    <tr>
      <td><code>retry</code></td>
      <td><code>handle</code> or <code>"all"</code></td>
      <td>Re-adds failed downloads</td>
    </tr>
    <tr>
      <td><code>purge</code></td>
      <td>none</td>
      <td>Clears finished/failed entries. <strong>Files are kept.</strong></td>
    </tr>
    <tr>
      <td><code>wait</code></td>
      <td>optional <code>handle</code>, <code>timeoutSec</code></td>
      <td>Sits in the current turn until they finish</td>
    </tr>
    <tr>
      <td><code>stats</code></td>
      <td>none</td>
      <td>Daemon version, speed, counts, directories</td>
    </tr>
  </tbody>
</table>

Notes:

- `add`: `url` is a string or an array, and `paused` queues without starting. An array queues **independent downloads**, one per URL — not a mirror list.
- `out` is a plain file name, not a path, and is only valid when adding one URL.
- `connections` is clamped to 1–16. `maxSpeed` accepts `"5M"`, `"500K"`, or bytes/second.
- `list` filters: `all`, `active`, `waiting`, `paused`, `done`, `failed`.
- `wait` keeps the downloads running after `timeoutSec` (1–3600, default 300) expires.
- Prefer `add` over `add` + `wait`: transfers run in a separate aria2 process, so they keep going after the turn ends and the next prompt starts a fresh turn instead of steering into a busy one.
- `handle` accepts the short `dl-*` handle, an aria2 gid, `"all"`, or an array.
- `wait` on a paused download returns immediately with a clear "nothing to wait for" message instead of blocking until the timeout.
- `wait` on an already-finished download reports it as already finished.
- The tool is `sequential`, because all calls share the same queue.

## Interactive UI

### Downloads dashboard

`Ctrl+Shift+O` replaces the prompt editor with a focused dashboard. Every line hangs off a left rail, the way the prompt itself is framed, and the selected row is drawn in bold with an accent rail and accent name so the selection is unmistakable. Rows share one column template — glyph, name, percent, bar, detail — so a download without progress blanks those cells instead of shifting its text left. Rows are one line each, and the selected download expands in place with its path, size, transfer time (`Took` once finished, `Elapsed` while running), live speed while it is active, and the error reason when it failed. Transfer time counts only the stretches actually spent downloading: queue wait and paused time are excluded. The prompt is hidden while the dashboard is open, so keystrokes drive the dashboard instead of the editor.

```text
┃ Downloads · 1 active · 1 done · 1 failed
┃
┃ ✗ Zap-x86_64.AppImage                failed · 0 B
┃ ✓ ZAP_2.17.0_Linux.tar.gz            100% ████████  411 MiB
┃      Path    ~/Download/Zap/ZAP_2.17.0_Linux.tar.gz
┃      URL     github.com/zaproxy/…/ZAP-x64.AppImage
┃      Size    411 MiB / 411 MiB
┃      Took    5m 0s
┃      Handle  dl-brisk-marten-15
┃ ● ubuntu-24.04.iso                    24% ██░░░░░░  2.3 MiB/s · 114 MiB
┃
┃ ↑↓ / j k move · ⏎ details · o open · p pause/resume · R retry · d remove · esc close
```

<table width="100%">
  <thead>
    <tr>
      <th align="left">Key</th>
      <th align="left">Action</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>↑</code> / <code>↓</code>, <code>j</code> / <code>k</code></td>
      <td>Select the previous/next download, wrapping at both ends</td>
    </tr>
    <tr>
      <td><code>Enter</code></td>
      <td>Expand or collapse the selected download's details</td>
    </tr>
    <tr>
      <td><code>o</code></td>
      <td>Open the selected file with the system's default program</td>
    </tr>
    <tr>
      <td><code>p</code></td>
      <td>Pause or resume the selected download</td>
    </tr>
    <tr>
      <td><code>R</code></td>
      <td>Retry the selected failed download</td>
    </tr>
    <tr>
      <td><code>d</code></td>
      <td>Remove it (press twice; files stay on disk)</td>
    </tr>
    <tr>
      <td><code>Esc</code> / <code>Ctrl+Shift+O</code></td>
      <td>Close and restore the prompt</td>
    </tr>
  </tbody>
</table>

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

<table width="100%">
  <thead>
    <tr>
      <th align="left">Field</th>
      <th align="left">Default</th>
      <th align="left">Meaning</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>defaultDir</code></td>
      <td><code>"."</code></td>
      <td>Directory used when a download names no <code>dir</code>; relative to Pi's cwd</td>
    </tr>
    <tr>
      <td><code>split</code></td>
      <td><code>8</code></td>
      <td>Connections per file, 1–16</td>
    </tr>
    <tr>
      <td><code>maxConcurrent</code></td>
      <td><code>5</code></td>
      <td>Simultaneous downloads, 1–20</td>
    </tr>
    <tr>
      <td><code>maxSpeed</code></td>
      <td>unset</td>
      <td>Global cap such as <code>"10M"</code></td>
    </tr>
    <tr>
      <td><code>notifyOnComplete</code></td>
      <td><code>true</code></td>
      <td>Toast on completion/failure</td>
    </tr>
    <tr>
      <td><code>persist</code></td>
      <td><code>true</code></td>
      <td>Save job intent across restarts</td>
    </tr>
    <tr>
      <td><code>stopWithPi</code></td>
      <td><code>true</code></td>
      <td>Tie the daemon lifetime to Pi</td>
    </tr>
    <tr>
      <td><code>allowedRoot</code></td>
      <td>unset</td>
      <td>Confine download directories</td>
    </tr>
    <tr>
      <td><code>pollIntervalMs</code></td>
      <td><code>800</code></td>
      <td>Poll interval while active, 250–5000</td>
    </tr>
    <tr>
      <td><code>enableDht</code></td>
      <td><code>false</code></td>
      <td>Enable BitTorrent DHT (opens a UDP port)</td>
    </tr>
  </tbody>
</table>

### Environment variables

<table width="100%">
  <thead>
    <tr>
      <th align="left">Variable</th>
      <th align="left">Effect</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>PI_ARIA2_BIN</code></td>
      <td>Explicit path to <code>aria2c</code></td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_HOME</code></td>
      <td>State/runtime directory (default <code>~/.pi/agent/pi-aria2</code>)</td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_DIR</code></td>
      <td>Override <code>defaultDir</code></td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_SPLIT</code></td>
      <td>Override <code>split</code></td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_MAX_CONCURRENT</code></td>
      <td>Override <code>maxConcurrent</code></td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_MAX_SPEED</code></td>
      <td>Override <code>maxSpeed</code></td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_NOTIFY</code></td>
      <td><code>0</code> / <code>1</code></td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_NO_PERSIST</code></td>
      <td><code>1</code> disables persistence</td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_KEEP_DAEMON</code></td>
      <td><code>1</code> lets the daemon outlive Pi (not recommended)</td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_ALLOWED_ROOT</code></td>
      <td>Override <code>allowedRoot</code></td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_POLL_MS</code></td>
      <td>Override <code>pollIntervalMs</code></td>
    </tr>
    <tr>
      <td><code>PI_ARIA2_DHT</code></td>
      <td><code>1</code> enables DHT</td>
    </tr>
  </tbody>
</table>

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

<table width="100%">
  <thead>
    <tr>
      <th align="left">File</th>
      <th align="left">Responsibility</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>src/index.ts</code></td>
      <td>Extension registration, tool surface, commands, renderers</td>
    </tr>
    <tr>
      <td><code>src/manager.ts</code></td>
      <td>Queue state, polling, persistence coordination, chrome updates</td>
    </tr>
    <tr>
      <td><code>src/daemon.ts</code></td>
      <td>Private aria2 process lifecycle and hardened config</td>
    </tr>
    <tr>
      <td><code>src/rpc.ts</code></td>
      <td><code>fetch</code>-based aria2 JSON-RPC client</td>
    </tr>
    <tr>
      <td><code>src/store.ts</code></td>
      <td>Atomic <code>0600</code> job persistence</td>
    </tr>
    <tr>
      <td><code>src/validate.ts</code></td>
      <td>URL, path, speed, and handle validation</td>
    </tr>
    <tr>
      <td><code>src/present.ts</code></td>
      <td>Pure text formatting for tool results</td>
    </tr>
    <tr>
      <td><code>src/dashboard.ts</code></td>
      <td>Focused dashboard that replaces the prompt editor</td>
    </tr>
    <tr>
      <td><code>src/config.ts</code></td>
      <td><code>config.json</code> plus environment overrides</td>
    </tr>
  </tbody>
</table>

## License

MIT.
