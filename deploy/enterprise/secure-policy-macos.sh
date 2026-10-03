#!/bin/bash
set -euo pipefail

policy=${1:-/Library/Application Support/DeepSeek Harness Enterprise/policy.json}
directory=$(dirname "$policy")

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run this command with sudo so the policy cannot be changed by the signed-in user.' >&2
  exit 1
fi
path=$(dirname "$directory")
while :; do
  if [[ -L "$path" || $(/usr/bin/stat -f '%u' "$path") != 0 ]]; then
    echo "Policy directory ancestry must be root-owned and contain no symbolic links: $path" >&2
    exit 1
  fi
  mode=$((8#$(/usr/bin/stat -f '%Lp' "$path")))
  if (( mode & 022 )); then
    echo "Policy directory ancestry must not be writable by group or other users: $path" >&2
    exit 1
  fi
  [[ "$path" == / ]] && break
  path=$(dirname "$path")
done

if [[ -L "$directory" ]]; then
  echo "Policy directory cannot be a symbolic link: $directory" >&2
  exit 1
fi
/bin/mkdir -p "$directory"
/usr/sbin/chown root:wheel "$directory"
/bin/chmod 755 "$directory"
if [[ ! -f "$policy" || -L "$policy" ]]; then
  echo "Expected a regular policy file at: $policy" >&2
  exit 1
fi
/usr/sbin/chown root:wheel "$policy"
/bin/chmod 644 "$policy"

echo "Secured enterprise policy: $policy"
