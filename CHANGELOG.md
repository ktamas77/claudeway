# Changelog

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
