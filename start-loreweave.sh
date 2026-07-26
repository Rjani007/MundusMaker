#!/bin/sh
# Loreweave launcher for Linux. Run with:  sh start-loreweave.sh
cd "$(dirname "$0")" || exit 1

# Prefer the bundled runtime if this is a one-click download
if [ -x "./runtime/bin/node" ]; then
  echo "Starting Loreweave... your browser will open in a moment."
  exec ./runtime/bin/node server.js
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Loreweave needs Node.js (free). Install it with your package manager,"
  echo "e.g.  sudo apt install nodejs   or from https://nodejs.org"
  exit 1
fi

echo "Starting Loreweave... your browser will open in a moment."
echo "Keep this terminal open while you use it. Ctrl+C to stop."
node server.js
