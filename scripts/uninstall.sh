#!/bin/bash
set -e

# Claudeway LaunchAgent uninstaller for macOS

LABEL="com.claudeway"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PLIST_PATH" ]; then
  echo "Claudeway LaunchAgent not found at $PLIST_PATH"
  exit 0
fi

echo "Stopping Claudeway service..."
launchctl unload "$PLIST_PATH" 2>/dev/null || true
sleep 2

echo "Removing LaunchAgent plist..."
rm -f "$PLIST_PATH"

echo "Cleaning up pidfile..."
rm -f "$PROJECT_DIR/claudeway.pid"

echo ""
echo "Claudeway service removed."
echo "Your .env, config.json, and logs are untouched."
