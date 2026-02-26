# Claudeway

Slack-to-Claude Code CLI gateway for solo developers.

## Design Concept

Claudeway is a **personal tool for a single developer** using their own Claude Max subscription through the official Claude Code CLI. It is not a multi-user service, does not extract OAuth tokens, and does not route requests through third-party backends.

It's just a remote terminal with Slack as the transport layer. You type in Slack, Claude Code runs on your machine, the response comes back to Slack. No TOS violations.

```
You (Slack) --> Socket Mode --> Claudeway (your machine) --> claude CLI --> response --> Slack
```

## How It Works

1. You send a message (with optional image attachments) in a configured Slack channel
2. Claudeway downloads any attached images to a temp directory, then either spawns a fresh `claude -p` process or pipes the message into a long-lived persistent process — depending on `processMode`
3. Claude Code reads your codebase, analyzes any attached images, runs tools, and produces a response
4. The response is posted back as a threaded reply in Slack
5. Reactions show status: `📥` (queued/received), ⏳ (processing), ✅ (done), ❌ (error). Deleting a queued message (📥) removes it from the queue — if it's already processing (⏳), use `!kill` instead.
6. Temp image files are cleaned up after processing

Each channel maps to a project folder, so you can have `#dashboard` pointing to your dashboard repo, `#api` pointing to your API, etc. Session IDs are derived deterministically from the channel + folder pair, so conversations persist across restarts — Claude remembers what you discussed earlier in the same channel.

## Self-Configuration

Dedicate one Slack channel to Claudeway itself (mapped to the claudeway folder). Then you can manage config through natural language:

- "Add channel C0123456789 named 'my-project' mapped to /path/to/project"
- "Remove the dashboard channel"
- "Change the model for #api to sonnet"

Claude Code edits the config file directly (JSON or YAML), and changes take effect on the next message.

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. **Enable Socket Mode** (Settings > Socket Mode) and generate an App-Level Token with `connections:write` scope
3. **Add Bot Token Scopes** (OAuth & Permissions):
   - `chat:write`
   - `channels:history`
   - `channels:read`
   - `files:read` (for image attachments)
   - `reactions:write`
4. **Subscribe to Bot Events** (Event Subscriptions):
   - `message.channels`
   - `message.groups` (for private channels)
5. **Install the app** to your workspace and copy the Bot Token (`xoxb-...`)
6. Invite the bot to your channels: `/invite @YourBot`

### 2. Configure Claudeway

```bash
git clone https://github.com/ktamas77/claudeway.git
cd claudeway
npm install
```

Create `.env`:
```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
```

Create `config.json` or `config.yaml` (YAML is recommended for readability — see [`config.example.yaml`](config.example.yaml)). If both exist, YAML takes priority.

```json
{
  "systemChannel": "C0123456789",
  "channels": {
    "C0123456789": {
      "name": "my-project",
      "folder": "/path/to/your/project"
    }
  },
  "defaults": {
    "model": "opus",
    "systemPrompt": "Format all responses using Slack mrkdwn syntax (NOT standard Markdown). Key rules: *bold* (single asterisk), _italic_ (underscore), ~strikethrough~ (single tilde), `code`, ```code blocks``` (no language tag), > blockquote, <URL|label> for links (NOT [label](url)), :emoji: shortcodes. Keep responses concise. You have access to the Claudeway config at CONFIG_PATH which you can read and edit when asked to add, remove, or update channel mappings.",
    "timeoutMs": 1800000,
    "processMode": "oneshot",
    "responseMode": "batch"
  }
}
```

Optionally, create `mcp.json` to give Claude access to MCP servers (e.g. persistent memory). See `mcp.example.json`:
```json
{
  "mcpServers": {
    "forever": {
      "type": "stdio",
      "command": "npx",
      "args": ["@squidcode/forever-plugin"]
    }
  }
}
```

### 3. Run

```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

### 4. Run as a Background Service (macOS)

The included install script sets up a macOS LaunchAgent that:
- Starts Claudeway automatically on login
- Restarts it automatically if it crashes (with a 10-second throttle to prevent crash loops)
- Only restarts on abnormal exits (clean `SIGTERM`/`SIGINT` shutdowns stay stopped)

```bash
./scripts/install.sh
```

To stop and remove the service:
```bash
./scripts/uninstall.sh
```

Useful commands:
```bash
launchctl list | grep claudeway                    # check status
tail -f claudeway.log                              # view logs
launchctl unload ~/Library/LaunchAgents/com.claudeway.plist   # stop temporarily
launchctl load -w ~/Library/LaunchAgents/com.claudeway.plist  # start again
```

The install script auto-detects your `node` path, project directory, and user environment. The generated plist is placed at `~/Library/LaunchAgents/com.claudeway.plist`.

## Config Options

### Top-level

| Field | Description | Default |
|-------|-------------|---------|
| `systemChannel` | Channel ID for startup/shutdown notifications | none (disabled) |
| `channels` | Channel-to-folder mappings | required |
| `defaults` | Default model, prompt, timeout, and response mode | required |

Set `systemChannel` to the ID of one of your configured channels. Claudeway will post a message there on startup and shutdown, so you can tell when it's running.

### Channel Config

| Field | Description | Default |
|-------|-------------|---------|
| `name` | Display name for logs | required |
| `folder` | Project folder path | required |
| `model` | Claude model (`opus`, `sonnet`) | from defaults |
| `systemPrompt` | Custom system prompt | from defaults |
| `timeoutMs` | Idle timeout in ms (resets on activity) | 1800000 (30 min) |
| `responseMode` | How responses are delivered (see below) | from defaults |
| `processMode` | How the Claude CLI process is managed (see below) | from defaults |

### Process Modes

Set `processMode` in `defaults` or per channel:

| Mode | Description |
|------|-------------|
| `oneshot` | Spawn a fresh `claude -p` process for every message. Default, simple, fully isolated. ~2-3s startup per message. |
| `persistent` | Keep one long-lived `claude -p` process per channel. Messages piped via stdin. Eliminates startup overhead and avoids re-loading session context on each turn. Idle-kills after `timeoutMs` of inactivity and auto-respawns on next message. |

`processMode` and `responseMode` are fully independent — any combination works.

### Response Modes

Set `responseMode` in `defaults` or per channel:

| Mode | Description |
|------|-------------|
| `batch` | Wait for the full response, then post it. Default, most reliable. |
| `stream-update` | Post a message immediately, then update it every ~500ms as text arrives. Uses `chat.update`. Recommended streaming mode. |
| `stream-native` | Use Slack's native streaming API via the typed SDK `ChatStreamer`. Sends `markdown_text` so Slack renders native Markdown. Shows a `:thinking_face:` placeholder until the first token arrives. Requires Enterprise Grid or `recipient_team_id` — will not work on standard Slack workspaces. |

Streaming modes give real-time feedback for long responses instead of showing an hourglass for 30+ seconds. If the final response exceeds the file upload threshold (12KB), streaming modes automatically fall back to uploading a file.

## Process Management

Control running Claude CLI processes directly from Slack with magic commands. These bypass the message queue and execute immediately.

| Command | Description |
|---------|-------------|
| `!ps` | List all active processes with channel, runtime, message count, token usage, and queue depth |
| `!kill` | Kill the process running in the current channel |
| `!kill #channel` | Kill a process in another channel by name |
| `!killall` | Kill all running processes |
| `!nudge` | Send SIGINT to the process in the current channel — interrupts a long tool call and prompts Claude to wrap up |
| `!nudge #channel` | Nudge a process in another channel by name |

Example `!ps` output:
```
:gear: Active Processes (2/8)

• #recycler — 18m 30s — 4 msgs — 18,234 tokens — "ok and don't forget to update your work log..." (idle)
• #claudeway — 26m 39s — 2 msgs — 9,103 tokens — "i think we can kill the reminders service..." :hourglass_flowing_sand:

Queued: 5 messages (3 recycler, 2 claudeway)
```

Killed processes are handled gracefully — the error handler posts a message in the thread and the channel's queue continues draining.

## Development

```bash
npm start          # Run with tsx
npm run dev        # Run with tsx watch (auto-reload)
npm run build      # TypeScript compile
npm run typecheck  # Type check only
npm run lint       # ESLint
npm run format     # Prettier
npm test           # Run unit tests
npm run test:watch # Watch mode
```

Unit tests cover the pure-function layer: NDJSON stream-json line parsing (the Claude CLI wire format), Slack mrkdwn conversion, message splitting, config resolution, session ID derivation, and path encoding. Tests run automatically on every commit via the pre-commit hook.

## Troubleshooting

**Messages queuing unexpectedly:** There's a global limit of 8 concurrent Claude CLI processes. If all slots are busy, new messages wait in queue until a slot frees up. Each channel also serializes its own messages (one at a time per channel).

**Process killed too early:** The `timeoutMs` setting is an idle timeout — it only kills the process after that many milliseconds of inactivity (no stdout/stderr). There's also a hard 12-hour absolute safety net. Increase `timeoutMs` per channel for long-running tasks.

**Claude hangs / no response:** Make sure stdin is not piped to the Claude process. Claudeway handles this internally by using `stdio: ['ignore', 'pipe', 'pipe']` when spawning the CLI.

**"Session ID already in use":** This happens when a previous Claude session didn't exit cleanly. Claudeway automatically clears stale session artifacts and retries once. No manual intervention needed.

**Service won't start via launchd:** Ensure `HOME` and `USER` are set in the plist's `EnvironmentVariables`. Claude Code needs these to find its auth credentials.

**"Cannot be launched inside another Claude Code session":** Don't start Claudeway from within a Claude Code terminal. The `CLAUDECODE` env var is inherited and blocks nested sessions. Start from a regular terminal or use the LaunchAgent.

**Only one instance runs at a time:** Claudeway uses a pidfile lock (`claudeway.pid`). If the service crashes, the stale pidfile is detected and cleaned up automatically.

**Images not being analyzed:** Make sure your Slack app has the `files:read` bot token scope. Supported formats: PNG, JPEG, GIF, WebP (max 5MB per image). Non-image files (PDFs, zips) are silently ignored.

## Pairs Well With

[maxassist](https://github.com/ktamas77/maxassist) - Use Claudeway as the communication layer and maxassist for orchestrating complex multi-step AI workflows. Together they form a powerful remote development setup.

[Forever Memory](https://forever.squidcode.com) - Persistent memory for Claude Code across folders and machines. Give your Claudeway channels shared context that survives session boundaries.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Claude Pro or Max subscription
- Node.js 20+

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
