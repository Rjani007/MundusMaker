#!/bin/sh
# MundusMaker launcher for Linux. Starts MundusMaker in the background, so
# closing this terminal does not stop it, and your browser opens once it is
# ready. Quit it from Settings in the app.
#
#   sh start-mundusmaker.sh                     start in the background
#   sh start-mundusmaker.sh --foreground        run in this terminal (Ctrl+C stops it)
#   sh start-mundusmaker.sh --install-desktop   add MundusMaker to your applications menu
cd "$(dirname "$0")" || exit 1

# Messages also go to a desktop notification when there is no terminal to show them.
say() {
  printf '%s\n' "$1"
  if [ ! -t 1 ] && command -v notify-send >/dev/null 2>&1; then notify-send MundusMaker "$1" 2>/dev/null; fi
}

if [ "$1" = "--install-desktop" ]; then
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps" || exit 1
  here=$(pwd)
  cat > "$apps/mundusmaker.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=MundusMaker
Comment=Local worldbuilding wiki for game masters
Exec=sh "$here/start-mundusmaker.sh"
Icon=$here/public/icons/icon-512.png
Terminal=false
Categories=Game;Office;
EOF
  echo "Added MundusMaker to your applications menu ($apps/mundusmaker.desktop)."
  exit 0
fi

# Select the bundled runtime for this computer; old portable layouts also work.
. ./scripts/unix-runtime.sh
mm_node=$(mundusmaker_runtime "./runtime") || mm_node=''
if [ -z "$mm_node" ]; then
  if ! command -v node >/dev/null 2>&1; then
    say "MundusMaker needs Node.js (free). Install it with your package manager, e.g. sudo apt install nodejs, or from https://nodejs.org"
    exit 1
  fi
  mm_node=node
fi

if [ "$1" = "--foreground" ]; then
  echo "Starting MundusMaker... your browser will open in a moment."
  echo "Keep this terminal open while you use it. Ctrl+C to stop."
  exec "$mm_node" server.js
fi

# The server writes its messages to logs/mundusmaker.log (in the config
# folder). Only lines added by this start count.
log="${MUNDUSMAKER_CONFIG_DIR:-.}/logs/mundusmaker.log"
start=$(wc -c < "$log" 2>/dev/null | tr -d ' ')
start=${start:-0}
since() {
  size=$(wc -c < "$log" 2>/dev/null | tr -d ' ')
  size=${size:-0}
  [ "$size" -lt "$start" ] && start=0 # the log rolled over
  tail -c +$((start + 1)) "$log" 2>/dev/null
}

echo "Starting MundusMaker..."
nohup "$mm_node" server.js --log >/dev/null 2>&1 &
pid=$!
tries=0
while [ "$tries" -lt 60 ]; do
  # the log first: a server that logged "serving on" started, whatever the
  # process state by the time this loop looks
  if since | grep -q 'serving on'; then
    say "MundusMaker is running in the background and your browser is opening. You can close this terminal; to stop MundusMaker, use Quit in Settings."
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"
    code=$?
    if [ "$code" -eq 0 ]; then
      say "MundusMaker was already running; your browser is opening it."
      exit 0
    fi
    reason=$(since | sed 's/^[^ ]* \[mundusmaker\] //' | grep -E 'Port |did not start|Quit the other|Close that program|stopped' | tail -n 4)
    say "MundusMaker did not start. ${reason:-Run: sh start-mundusmaker.sh --foreground to see why.}"
    exit "$code"
  fi
  sleep 1
  tries=$((tries + 1))
done
say "MundusMaker is still starting. If your browser does not open, see $log"
