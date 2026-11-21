#!/bin/sh
# Check the installed plugin inside the pi on PATH, in a scratch directory:
# pi must load it, register the tool and the command, and the tool must report
# the bin directory pi itself searches (getBinDir()).
#
#   ./scripts/verify.sh            # tool: status
#   ./scripts/verify.sh update     # tool: update
#
# Needs a configured provider (any API key pi already uses) and network access
# for the status lookup. Exits non-zero when pi cannot see the tool.
set -eu

action=${1:-status}
case $action in
status | update) ;;
*)
	echo "usage: $0 [status|update]" >&2
	exit 2
	;;
esac

install_dir=$(cd "$(dirname "$0")/.." && pwd)

if ! pi list 2>/dev/null | grep -qF "$install_dir"; then
	echo "FAIL: $install_dir is not installed in pi. Run: pi install $install_dir" >&2
	exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

prompt="Use the managed_tools tool once with action \"$action\" and then repeat its output verbatim. Do not use any other tool."
output=$(pi --no-session -p "$prompt" </dev/null) || {
	echo "FAIL: pi exited non-zero" >&2
	echo "$output" >&2
	exit 1
}

printf '%s\n' "$output"
printf '%s\n' "$output" | grep -q "bin dir: " || {
	echo "FAIL: the tool output above does not name pi's bin directory" >&2
	exit 1
}

echo "OK: pi loaded pi-managed-tools and ran managed_tools ($action)"
