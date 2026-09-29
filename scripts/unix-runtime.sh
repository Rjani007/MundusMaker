#!/bin/sh
# Shared by the portable launchers and the Finder app. Runs in a subshell so
# sourcing this file does not change the launcher's variables or directory.
mundusmaker_runtime() (
  mm_runtime_dir=$1
  mm_runtime_system=${2:-$(uname -s)}
  mm_runtime_arch=${3:-$(uname -m)}
  case "$mm_runtime_system:$mm_runtime_arch" in
    Linux:x86_64|Linux:amd64) mm_runtime_target=linux-x64 ;;
    Linux:aarch64|Linux:arm64) mm_runtime_target=linux-arm64 ;;
    Darwin:x86_64|Darwin:amd64) mm_runtime_target=macos-x64 ;;
    Darwin:arm64|Darwin:aarch64) mm_runtime_target=macos-arm64 ;;
    *) return 1 ;;
  esac
  for mm_runtime_node in "$mm_runtime_dir/$mm_runtime_target/bin/node" "$mm_runtime_dir/bin/node"; do
    if [ -x "$mm_runtime_node" ]; then
      printf '%s\n' "$mm_runtime_node"
      return 0
    fi
  done
  return 1
)
