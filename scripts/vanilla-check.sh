#!/usr/bin/env bash
#
# Install this package the way a stranger would, then assert it loaded correctly.
#
# Three modes:
#
#   container (default)  A stock node:24 image with nothing on it. `pi` comes from npm at
#                        the pinned version, the package is cloned from GitHub at the ref,
#                        and scripts/check-commands.mjs has to pass. This is the only mode
#                        that is genuinely vanilla: no other package, no extension checkout,
#                        no auth, no skills.
#
#   --local              Your machine, but with PI_CODING_AGENT_DIR pointed at a throwaway
#                        directory, so settings/packages/auth are all empty. Installs the
#                        working tree. Seconds instead of minutes — use this while
#                        iterating, and the container before you tag.
#
#   --local --from-git   Same isolation, but the source is the git ref instead of the working
#                        tree. This is what CI runs on a tag push, so it proves the clone
#                        path and that the tag points where you think it does.
#
# The router's own env vars are scrubbed in both modes unless you ask for them, because a
# TYPESAFE_API_KEY exported in your shell would otherwise silently switch the run from the
# heuristic path to Jev.
#
# Usage:
#   scripts/vanilla-check.sh                     # container, current version's tag
#   scripts/vanilla-check.sh --local             # fast loop, working tree
#   scripts/vanilla-check.sh --ref v0.1.0        # some other tag/branch/commit
#   scripts/vanilla-check.sh --local --from-git --expect-commit "$SHA"
#   scripts/vanilla-check.sh --with-key          # pass TYPESAFE_API_KEY through
#   scripts/vanilla-check.sh --auth              # mount ~/.pi/agent/auth.json into the container
#   scripts/vanilla-check.sh --shell             # checks pass, then leave a container running to poke at
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

MODE="container"
FROM_GIT=0
REF=""
PI_VERSION=""
EXPECT_COMMIT="${EXPECT_COMMIT:-}"
WITH_KEY=0
WITH_AUTH=0
INTERACTIVE=0
KEEP=0

ROUTER_VARS=(TYPESAFE_API_KEY TYPESAFE_BASE_URL TASK_ROUTER_PROVIDER TASK_ROUTER_JEV_MODEL TASK_ROUTER_TIERS)

usage() { sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
	case "$1" in
		--local) MODE="local" ;;
		--container) MODE="container" ;;
		--from-git) FROM_GIT=1 ;;
		--ref) REF="${2:?--ref needs a value}"; shift ;;
		--pi-version) PI_VERSION="${2:?--pi-version needs a value}"; shift ;;
		--expect-commit) EXPECT_COMMIT="${2:?--expect-commit needs a value}"; shift ;;
		--with-key) WITH_KEY=1 ;;
		--auth) WITH_AUTH=1 ;;
		--shell|--interactive) INTERACTIVE=1 ;;
		--keep) KEEP=1 ;;
		-h|--help) usage; exit 0 ;;
		*) echo "unknown flag: $1" >&2; usage; exit 2 ;;
	esac
	shift
done

# Version, ref and pi version all default to package.json, so a bump does not leave this
# script (or CI) pointing at the previous release.
VERSION="$(node -p "require('./package.json').version")"
if [ -z "$PI_VERSION" ]; then
	PI_VERSION="$(node -p "require('./package.json').devDependencies['@earendil-works/pi-coding-agent'].replace(/^[\^~]/,'')")"
fi
REF="${REF:-v$VERSION}"
SOURCE="${SOURCE:-git:github.com/rizafahmi/pi-jev-task-router@$REF}"

# Env scrubber: `env -u X` per known router var, minus TYPESAFE_API_KEY when asked for.
scrub=(env)
for var in "${ROUTER_VARS[@]}"; do
	if [ "$WITH_KEY" = 1 ] && [ "$var" = "TYPESAFE_API_KEY" ]; then continue; fi
	scrub+=(-u "$var")
done
scrub+=(-u PI_TELEMETRY)

banner() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Local-path mode never installs from git, so name the source accordingly.
DISPLAY_SOURCE="$SOURCE"
if [ "$MODE" = "local" ] && [ "$FROM_GIT" = 0 ]; then DISPLAY_SOURCE="working tree ($REPO)"; fi

banner "vanilla-check · mode=$MODE · pi=$PI_VERSION · source=$DISPLAY_SOURCE"
if [ -n "$EXPECT_COMMIT" ]; then echo "  note: expecting the clone at $EXPECT_COMMIT"; fi
if [ "$WITH_KEY" = 1 ]; then
	case "${TYPESAFE_API_KEY:-}" in
		"") echo "  note: --with-key given but TYPESAFE_API_KEY is unset; the run will use the heuristic" ;;
		*) echo "  note: TYPESAFE_API_KEY passed through — expect the Jev path" ;;
	esac
fi

# Pi clones a git package to <agent dir>/git/<host>/<owner>/<repo>. Derive that from the
# source so a fork or another host still resolves.
derive_clone_path() {
	local agent_dir="$1" source="$2" s
	s="${source#git:}"
	s="${s#https://}"; s="${s#http://}"; s="${s#ssh://}"; s="${s#git://}"
	s="${s#git@}"
	s="${s%@*}"        # only the ref separator is left by now
	s="${s/:/\/}"      # git@host:owner/repo form
	printf '%s/git/%s' "$agent_dir" "$s"
}

# Every mode ends the same way: the clone is where we think it is, it is the commit we
# think it is, and the package registered its commands exactly once.
verify_common() {
	local agent_dir="$1" clone="$2"

	if [ "$FROM_GIT" = 1 ]; then
		[ -d "$clone" ] || { echo "FAILED: no clone at $clone" >&2; exit 1; }
		local head
		head="$(git -C "$clone" rev-parse HEAD)"
		printf -- '-- clone: %s (%s)\n' "$head" "$(git -C "$clone" describe --tags --always 2>/dev/null || echo "no tag")"
		if [ -n "$EXPECT_COMMIT" ] && [ "$head" != "$EXPECT_COMMIT" ]; then
			echo "FAILED: clone HEAD $head does not match expected commit $EXPECT_COMMIT" >&2
			echo "        the ref $REF is not the commit you think it is" >&2
			exit 1
		fi

		# The clone shipped to the user is what should pass the tests, not the working tree.
		echo
		echo "-- node --test inside the installed clone (offline, no node_modules needed)"
		( cd "$clone" && node --test 2>&1 | tail -8 )
	fi

	echo
	PI_CODING_AGENT_DIR="$agent_dir" "${scrub[@]}" node "$REPO/scripts/check-commands.mjs"
}

# ---------------------------------------------------------------------------
# container
# ---------------------------------------------------------------------------
run_container() {
	command -v podman >/dev/null 2>&1 || { echo "podman is not installed (or use --local)" >&2; exit 2; }
	podman info >/dev/null 2>&1 || { echo "podman is unreachable — start it: podman machine start (or use --local)" >&2; exit 2; }

	local container_dir="/root/.pi/agent"
	local clone_path
	clone_path="$(derive_clone_path "$container_dir" "$SOURCE")"

	local args=(--rm -i
		-e "PI_VERSION=$PI_VERSION"
		-e "PKG_SOURCE=$SOURCE"
		-e "CLONE_PATH=$clone_path"
		-v "$REPO/scripts:/scripts:ro")

	if [ "$WITH_KEY" = 1 ]; then
		args+=(-e "TYPESAFE_API_KEY=${TYPESAFE_API_KEY:-}" -e "TASK_ROUTER_PROVIDER=${TASK_ROUTER_PROVIDER:-}")
	fi
	if [ "$WITH_AUTH" = 1 ]; then
		[ -f "$HOME/.pi/agent/auth.json" ] || { echo "--auth: $HOME/.pi/agent/auth.json not found" >&2; exit 2; }
		args+=(-v "$HOME/.pi/agent/auth.json:$container_dir/auth.json:ro")
		echo "  note: mounting your auth.json read-only — the container may use your provider credentials"
	fi

	local inner
	inner=$(cat <<'INNER'
set -euo pipefail
export PI_TELEMETRY=0
export PI_CODING_AGENT_DIR=/root/.pi/agent

echo "-- installing git + pi@$PI_VERSION"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates >/dev/null
npm install -g "@earendil-works/pi-coding-agent@$PI_VERSION" >/dev/null 2>&1

echo "-- pi install $PKG_SOURCE"
pi install "$PKG_SOURCE"

echo
echo "-- settings.json"
cat "$PI_CODING_AGENT_DIR/settings.json"
echo

if [ -d "$CLONE_PATH" ]; then
	echo "-- node_modules in the package: $( [ -d "$CLONE_PATH/node_modules" ] && echo present || echo absent )"
fi
INNER
)

	# verify_common runs on the host for --local; in the container the same assertions run
	# inside, against the container's own agent dir.
	inner="$inner
node /scripts/check-commands.mjs

if [ -d \"\$CLONE_PATH\" ]; then
	echo
	echo \"-- node --test inside the installed clone (offline, no node_modules needed)\"
	( cd \"\$CLONE_PATH\" && node --test 2>&1 | tail -8 )
fi

cat <<'DONE'

-- not covered here: /router-check, /router-config and the per-prompt switching are TUI
   behaviour, so they cannot run in this non-interactive check. Re-run with --shell and
   try them by hand.
DONE"

	if [ "$INTERACTIVE" = 1 ]; then
		echo "  note: --shell leaves the container (named pi-vanilla-check) running when you exit"
		podman run "${args[@]}" --name pi-vanilla-check --entrypoint bash node:24-bookworm-slim -lc "$inner
set +e
echo
echo '-- checks done. Shell in the container:'
echo '   pi is installed, the package is loaded, PI_CODING_AGENT_DIR is /root/.pi/agent'
echo '   Run: pi         (needs --auth for a model, --with-key for Jev)'
echo '   Then try: /router-config   and   /router-check --fake'
exec bash"
		return
	fi

	podman run "${args[@]}" node:24-bookworm-slim bash -lc "$inner"
}

# ---------------------------------------------------------------------------
# local
# ---------------------------------------------------------------------------
AGENT_DIR=""
cleanup_agent_dir() {
	[ -n "$AGENT_DIR" ] || return 0
	if [ "$KEEP" = 1 ]; then
		printf '  agent dir kept: %s\n' "$AGENT_DIR"
		return 0
	fi
	rm -rf "$AGENT_DIR"
}

run_local() {
	command -v pi >/dev/null 2>&1 || { echo "pi is not on PATH — npm i -g @earendil-works/pi-coding-agent" >&2; exit 2; }

	AGENT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-vanilla.XXXXXX")"
	trap cleanup_agent_dir EXIT

	local source
	if [ "$FROM_GIT" = 1 ]; then source="$SOURCE"; else source="${LOCAL_SOURCE:-$REPO}"; fi

	echo "-- pi install $source"
	PI_CODING_AGENT_DIR="$AGENT_DIR" "${scrub[@]}" pi install "$source"

	echo
	echo "-- settings.json"
	cat "$AGENT_DIR/settings.json"
	echo

	verify_common "$AGENT_DIR" "$(derive_clone_path "$AGENT_DIR" "$source")"

	echo
	echo "  note: this mode still reads skills from $HOME/.agents/skills and $HOME/.pi/agent/skills."
	echo "        Packages and auth are isolated; skills are not. Use the container for a run"
	echo "        with nothing of yours in it."
}

if [ "$MODE" = "container" ]; then run_container; else run_local; fi

banner "vanilla-check: PASSED — $DISPLAY_SOURCE loads once, as a package"
