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
    "systemPrompt": "Be concise. Format responses for Slack mrkdwn. You have access to the Claudeway config at CONFIG_PATH which you can read and edit when asked to add, remove, or update channel mappings.",
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

Create a LaunchAgent to start Claudeway automatically on login:

```bash
cat > ~/Library/LaunchAgents/com.claudeway.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claudeway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/path/to/claudeway/node_modules/.bin/tsx</string>
        <string>/path/to/claudeway/src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claudeway</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/path/to/claudeway/claudeway.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/claudeway/claudeway.log</string>
</dict>
</plist>
EOF
```

Then load it:
```bash
launchctl load ~/Library/LaunchAgents/com.claudeway.plist
```

Useful commands:
```bash
launchctl unload ~/Library/LaunchAgents/com.claudeway.plist   # stop
launchctl list | grep claudeway                                # status
tail -f ~/dev/ktamas77/claudeway/claudeway.log                 # logs
```

## Channel Config Options

| Field | Description | Default |
|-------|-------------|---------|
| `name` | Display name for logs | required |
| `folder` | Project folder path | required |
| `model` | Claude model (`opus`, `sonnet`) | from defaults |
| `systemPrompt` | Custom system prompt | from defaults |
| `timeoutMs` | CLI timeout in ms | 300000 (5 min) |

## Pairs Well With

[maxassist](https://github.com/ktamas77/maxassist) - Use Claudeway as the communication layer and maxassist for orchestrating complex multi-step AI workflows. Together they form a powerful remote development setup.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Claude Pro or Max subscription
- Node.js 20+

## License

MIT
