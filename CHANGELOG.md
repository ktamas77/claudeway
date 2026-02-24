# Changelog

## [0.11.0] - 2026-02-23

### Added
- **Message delete detection**: Deleting a queued Slack message (📥) automatically removes it from the processing queue. If a message is already being processed (⏳), deletion has no effect — use `!kill` to interrupt in-flight processing.

## [0.10.0] - 2026-02-23

### Changed
- **Improved Markdown-to-mrkdwn conversion**: `markdownToSlackMrkdwn()` is now code-block-aware — conversions only run on non-code segments so fenced code content is never mangled
- **Bullet point support**: `- item` and `* item` lines are converted to `• item` (Slack has no native bullet syntax)
- **HTML entity escaping**: bare `<` and `&` in plain text are escaped to `&lt;` / `&amp;` before Slack processes the message, preventing accidental mrkdwn token interpretation; Markdown link tokens (`<url|text>`) are created after escaping and remain correct

## [0.9.0] - 2026-02-23

### Changed
- **`stream-native` mode uses typed SDK `chatStream()`**: Replaced raw `apiCall('chat.startStream/appendStream/stopStream')` with the `@slack/web-api` `ChatStreamer` SDK class. Responses are now sent as `markdown_text` so Slack renders native Markdown — no mrkdwn conversion needed.
- **Thinking preview for `stream-native`**: A `:thinking_face: thinking...` placeholder message is posted immediately before Claude starts processing. It's deleted as soon as the first text delta arrives, replaced by the live stream.
- **Faster `stream-update` flush interval**: Reduced from 1000ms to 500ms for snappier real-time updates.

## [0.8.0] - 2026-02-23

### Added
- **`!nudge` command**: Send SIGINT to a running Claude process to interrupt a long tool call and prompt it to wrap up. Works on both persistent and oneshot processes.
  - `!nudge` — nudge the process in the current channel
  - `!nudge #channel` — nudge a process in another channel by name
- **Richer `!ps` output**: Each process line now shows message count, token count (falling back to cost if tokens are unavailable), and an active `:hourglass_flowing_sand:` / `(idle)` indicator
  - Token/cost omitted for fresh or in-flight oneshot processes (not available until exit)
  - Persistent processes accumulate stats turn-by-turn

## [0.7.0] - 2026-02-23

### Added
- **Unit test suite**: 67 tests across 4 files using Jest + ts-jest
  - `ndjson.test.ts` — NDJSON stream-json line parsing (text deltas, result events, user receipts, edge cases)
  - `slack.test.ts` — Markdown-to-mrkdwn conversion, message splitting, duration formatting
  - `config.test.ts` — Config resolution and channel lookups including `processMode`
  - `claude.test.ts` — Session ID derivation (with regression guard), session artifact path encoding
- **Queued reaction**: Bot now reacts with `:inbox_tray:` immediately on message receipt, before any processing begins — provides instant acknowledgement even when a channel is busy
- Tests run automatically on every commit via pre-commit hook (Husky)

### Changed
- Reaction transitions always add the new emoji before removing the old one to prevent visual jumps in Slack
- Refactored internal NDJSON line parsing into a module-level `parseStreamLine()` function shared by both streaming and persistent process paths

## [0.6.0] - 2026-02-23

### Added
- **Persistent process mode**: `processMode: 'persistent'` config option keeps a long-lived Claude CLI
  process per channel. Messages piped via stdin instead of spawning a new process each time —
  eliminates ~2-3s startup overhead and reduces repeated context-loading token costs.
- `processMode` configurable in `defaults` and per channel. Default is `'oneshot'` (fully backwards compatible).
- Persistent processes idle-kill after `timeoutMs` ms of inactivity and auto-respawn on next message.
- All three `responseMode` options (`batch`, `stream-update`, `stream-native`) work with `processMode: persistent`.
- `!ps` and `!kill`/`!killall` commands now include persistent processes in their output/control.

## [0.5.0] - 2026-02-23

### Added
- **Process management commands**: Control running Claude CLI processes directly from Slack
  - `!ps` — list all active processes with channel name, runtime, prompt snippet, and queue stats
  - `!kill` — kill the process running in the current channel
  - `!kill #channel` — kill a process in another channel by name
  - `!killall` — kill all running processes
- **Process registry**: Internal tracking of all running Claude CLI processes, enabling external visibility and control
- Magic commands bypass the message queue and concurrency limits — they execute immediately

## [0.4.1] - 2026-02-23

### Added
- **Global concurrency limit**: Max 8 Claude CLI processes running simultaneously across all channels. Additional messages queue and wait for a slot.

## [0.4.0] - 2026-02-23

### Added
- **Idle-based timeout**: Process timeout now resets on any stdout/stderr activity, so long-running tasks that are actively working won't be killed
- **Absolute timeout safety net**: Hard 12-hour maximum runtime regardless of activity
- **Atomic config save**: `saveConfig()` now writes to a temp file, validates JSON, then atomically renames to prevent corrupt config

### Changed
- Default `timeoutMs` now represents idle timeout (inactivity) rather than absolute elapsed time

## [0.3.0] - 2025-02-23

### Added
- **Image attachment support**: Attach PNG, JPEG, GIF, or WebP images in Slack and Claude will analyze them
  - Images downloaded from Slack using bot token auth, saved to temp directory
  - Image-only messages auto-prompt "What is in this image?"
  - Text + image messages pass both to Claude
  - Temp files automatically cleaned up after processing
  - 5MB per-image size limit
- Requires `files:read` Slack bot token scope

## [0.2.0] - 2025-02-22

### Added
- **Streaming responses**: Real-time message updates in Slack as Claude generates text, instead of waiting for the full response
  - `stream-update` mode: posts a message immediately, updates it every ~2 seconds via `chat.update`
  - `stream-native` mode: uses Slack's native streaming API (`chat.startStream`/`appendStream`/`stopStream`) — experimental
- New `responseMode` config option in `defaults` and per-channel (`batch`, `stream-update`, `stream-native`)
- Long streaming responses automatically fall back to file upload when exceeding 12KB
- Multi-chunk message splitting for streaming responses that exceed Slack's single-message limit

### Changed
- Refactored Claude CLI process spawning to share common logic between batch and streaming modes

## [0.1.0] - 2025-02-15

Initial release.

### Features
- Slack-to-Claude Code CLI gateway via Socket Mode
- Per-channel project folder mapping with deterministic session IDs
- Session persistence across restarts (automatic resume)
- MCP server support (`mcp.json`)
- Self-configuration via natural language in a dedicated Slack channel
- Persistent file-based message queue (survives restarts)
- macOS LaunchAgent support with install/uninstall scripts
- Markdown-to-Slack mrkdwn conversion
- System channel notifications (startup/shutdown)
- Pidfile lock for single-instance enforcement
- Orphan process cleanup on startup
