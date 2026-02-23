#!/bin/bash
set -e

# Claudeway LaunchAgent installer for macOS
# Installs a launchd service that auto-starts Claudeway on login
# and restarts it if it crashes.

LABEL="com.claudeway"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find node binary
NODE_BIN=$(which node 2>/dev/null)
if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH"
  exit 1
fi

TSX_BIN="$PROJECT_DIR/node_modules/.bin/tsx"
if [ ! -f "$TSX_BIN" ]; then
  echo "Error: tsx not found. Run 'npm install' first."
  exit 1
fi

# Check prerequisites
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "Error: .env file not found. Copy .env.example and fill in your Slack tokens."
  exit 1
fi

if [ ! -f "$PROJECT_DIR/config.json" ]; then
  echo "Error: config.json not found. Copy config.example.json and configure your channels."
  exit 1
fi

# Unload existing service if running
if launchctl list | grep -q "$LABEL" 2>/dev/null; then
  echo "Stopping existing Claudeway service..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  sleep 2
fi

# Clean up stale pidfile
rm -f "$PROJECT_DIR/claudeway.pid"

echo "Installing LaunchAgent to $PLIST_PATH"

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${TSX_BIN}</string>
        <string>${PROJECT_DIR}/src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>USER</key>
        <string>${USER}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${PROJECT_DIR}/claudeway.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_DIR}/claudeway.log</string>
</dict>
</plist>
EOF

launchctl load -w "$PLIST_PATH"
sleep 3

if launchctl list | grep -q "$LABEL"; then
  echo ""
  echo "Claudeway installed and running!"
  echo ""
  echo "Useful commands:"
  echo "  tail -f $PROJECT_DIR/claudeway.log   # view logs"
  echo "  launchctl list | grep claudeway       # check status"
  echo "  scripts/uninstall.sh                  # stop and remove"
else
  echo "Error: service failed to start. Check $PROJECT_DIR/claudeway.log"
  exit 1
fi
