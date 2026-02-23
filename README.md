# Claudeway

Slack-to-Claude Code CLI gateway for solo developers.

## Design Concept

Claudeway is a **personal tool for a single developer** using their own Claude Max subscription through the official Claude Code CLI. It is not a multi-user service, does not extract OAuth tokens, and does not route requests through third-party backends.

It's just a remote terminal with Slack as the transport layer. You type in Slack, Claude Code runs on your machine, the response comes back to Slack. No TOS violations.

```
You (Slack) --> Socket Mode --> Claudeway (your machine) --> claude CLI --> response --> Slack
```

## How It Works

1. You send a message in a configured Slack channel
2. Claudeway spawns `claude -p` in the mapped project folder with a deterministic session ID
3. Claude Code reads your codebase, runs tools, and produces a response
4. The response is posted back as a threaded reply in Slack
5. Reactions show status: hourglass (processing), checkmark (done), X (error)

Each channel maps to a project folder, so you can have `#dashboard` pointing to your dashboard repo, `#api` pointing to your API, etc. Session IDs are derived deterministically from the channel + folder pair, so conversations persist across restarts.

## Self-Configuration

Dedicate one Slack channel to Claudeway itself (mapped to the claudeway folder). Then you can manage config through natural language:

- "Add channel C0123456789 named 'my-project' mapped to /path/to/project"
- "Remove the dashboard channel"
- "Change the model for #api to sonnet"

Claude Code edits `config.json` directly, and changes take effect on the next message.

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. **Enable Socket Mode** (Settings > Socket Mode) and generate an App-Level Token with `connections:write` scope
3. **Add Bot Token Scopes** (OAuth & Permissions):
   - `chat:write`
   - `channels:history`
   - `channels:read`
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

Create `config.json`:
```json
{
  "channels": {
    "C0123456789": {
      "name": "my-project",
      "folder": "/path/to/your/project"
    }
  },
  "defaults": {
    "model": "opus",
    "systemPrompt": "Format all responses using Slack mrkdwn syntax (NOT standard Markdown). Key rules: *bold* (single asterisk), _italic_ (underscore), ~strikethrough~ (single tilde), `code`, ```code blocks``` (no language tag), > blockquote, <URL|label> for links (NOT [label](url)), :emoji: shortcodes. Keep responses concise. You have access to the Claudeway config at CONFIG_PATH which you can read and edit when asked to add, remove, or update channel mappings.",
    "timeoutMs": 300000
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

## Channel Config Options

| Field | Description | Default |
|-------|-------------|---------|
| `name` | Display name for logs | required |
| `folder` | Project folder path | required |
| `model` | Claude model (`opus`, `sonnet`) | from defaults |
| `systemPrompt` | Custom system prompt | from defaults |
| `timeoutMs` | CLI timeout in ms | 300000 (5 min) |

## Troubleshooting

**Claude hangs / no response:** Make sure stdin is not piped to the Claude process. Claudeway handles this internally by using `stdio: ['ignore', 'pipe', 'pipe']` when spawning the CLI.

**"Session ID already in use":** This happens when a previous Claude session with the same deterministic ID didn't exit cleanly. Claudeway automatically falls back to a fresh session without the session ID. The stale session will expire on its own.

**Service won't start via launchd:** Ensure `HOME` and `USER` are set in the plist's `EnvironmentVariables`. Claude Code needs these to find its auth credentials.

**"Cannot be launched inside another Claude Code session":** Don't start Claudeway from within a Claude Code terminal. The `CLAUDECODE` env var is inherited and blocks nested sessions. Start from a regular terminal or use the LaunchAgent.

**Only one instance runs at a time:** Claudeway uses a pidfile lock (`claudeway.pid`). If the service crashes, the stale pidfile is detected and cleaned up automatically.

## Pairs Well With

[maxassist](https://github.com/ktamas77/maxassist) - Use Claudeway as the communication layer and maxassist for orchestrating complex multi-step AI workflows. Together they form a powerful remote development setup.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Claude Pro or Max subscription
- Node.js 20+

## License

MIT
