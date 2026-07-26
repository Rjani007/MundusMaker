#!/bin/bash
# TomeWeaver launcher for macOS. If double-clicking says the file can't run,
# open Terminal and run:  bash "Start-TomeWeaver.command"
cd "$(dirname "$0")"

# Prefer the bundled runtime if this is a one-click download
if [ -x "./runtime/bin/node" ]; then
  echo ""
  echo "Starting TomeWeaver... your browser will open in a moment."
  echo "Keep this window open while you use it. Close it to stop."
  echo ""
  exec ./runtime/bin/node server.js
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "============================================================"
  echo " TomeWeaver needs Node.js (free, one-time install)."
  echo ""
  echo " 1. Your browser will open nodejs.org — download the LTS"
  echo "    version and run the installer."
  echo " 2. Then double-click Start-TomeWeaver.command again."
  echo "============================================================"
  echo ""
  open "https://nodejs.org"
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

echo ""
echo "Starting TomeWeaver... your browser will open in a moment."
echo "Keep this window open while you use it. Close it to stop."
echo ""
node server.js
