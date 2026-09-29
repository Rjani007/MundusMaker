#!/bin/bash
# Compatibility shortcut. Opening MundusMaker.app directly avoids Terminal.
cd "$(dirname "$0")" || exit 1

if [ -d "./MundusMaker.app" ]; then
  exec /usr/bin/open "./MundusMaker.app"
fi
if [ -d "/Applications/MundusMaker.app" ]; then
  exec /usr/bin/open "/Applications/MundusMaker.app"
fi

# Source checkouts and older portable installations can still run directly.
. ./scripts/unix-runtime.sh
mm_node=$(mundusmaker_runtime "./runtime") || mm_node=''
if [ -n "$mm_node" ]; then
  echo ""
  echo "Starting MundusMaker... your browser will open in a moment."
  echo "Keep this window open while you use it. Close it to stop."
  echo ""
  exec "$mm_node" server.js
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "============================================================"
  echo " MundusMaker needs Node.js (free, one-time install)."
  echo ""
  echo " 1. Your browser will open nodejs.org — download the LTS"
  echo "    version and run the installer."
  echo " 2. Then double-click Start-MundusMaker.command again."
  echo "============================================================"
  echo ""
  open "https://nodejs.org"
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

echo ""
echo "Starting MundusMaker... your browser will open in a moment."
echo "Keep this window open while you use it. Close it to stop."
echo ""
node server.js
