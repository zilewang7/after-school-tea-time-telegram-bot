#!/bin/bash
#
# Stage 2 of the container start (build.sh is stage 1 and only fetches).
# Installs what changed, builds into staging directories, swaps them in and
# starts the bot under pm2.
#
# The old process is already gone when this runs, so every second here is
# downtime: the install and the webapp build are skipped when their inputs
# have not changed, and the server is compiled without type checking
# (`pnpm check` does that before a push).
#
# A failed install or build must not take the bot down. If a previous build is
# still in place it is started, with the packages it was built with, and
# /api/health keeps reporting the commit that build came from. With nothing to
# fall back to (a container that was just created) the script exits non-zero
# and docker starts it again.
#
# No `set -e`: each step decides what its own failure means.

set -u
cd /app/k-on-bot || exit 1

log() { echo "[deploy] $*"; }

COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
lock_hash() { cat pnpm-lock.yaml pnpm-workspace.yaml | sha256sum | cut -d' ' -f1; }
LOCK_HASH=$(lock_hash)

# What an install reads: the lockfile, the workspace settings and every
# package.json (the ones outside the workspace are along for the ride).
dependency_manifests() { git ls-files -- package.json '*/package.json' pnpm-lock.yaml pnpm-workspace.yaml; }

# Both markers sit inside the directory they describe: when the directory is
# gone, so is the marker, and the step runs again.
INSTALL_MARKER=node_modules/.k-on-bot-install-hash
WEBAPP_MARKER=webapp/dist/.build-hash

run_install() {
    # tools/checks holds development-only tools. The filter alone is not
    # enough: with pnpm's default dedupe-peer-dependents a filtered install
    # still installs every project of the workspace.
    pnpm install --frozen-lockfile --filter '!k-on-bot-checks' --config.dedupe-peer-dependents=false "$@"
}

# Set once an install has run for this commit, whether or not it succeeded
install_attempted=0

install_dependencies() {
    if [ "$(cat "$INSTALL_MARKER" 2>/dev/null)" = "$LOCK_HASH" ] && [ -d webapp/node_modules ]; then
        log "dependencies unchanged, install skipped"
        return 0
    fi
    log "installing dependencies"
    install_attempted=1
    run_install || return 1
    echo "$LOCK_HASH" > "$INSTALL_MARKER"
}

# A build keeps the manifests its packages were installed from (dist/.deps),
# so those packages can be installed again when a later commit fails to build.
remember_dependencies() {
    local manifest
    for manifest in $(dependency_manifests); do
        mkdir -p "dist.next/.deps/$(dirname "$manifest")" && cp "$manifest" "dist.next/.deps/$manifest" || return 1
    done
}

# The previous build is about to start. An install that ran for the commit
# that failed has replaced its packages: without this step an SDK upgrade
# whose build fails leaves the old code running against the new SDK.
restore_previous_dependencies() {
    [ "$install_attempted" -eq 1 ] || return 0
    if [ ! -f dist/.deps/pnpm-lock.yaml ]; then
        log "the previous build has no record of its packages; it starts with the ones just installed"
        return 0
    fi
    log "putting back the packages of the previous build"
    local manifest restored=1
    for manifest in $(cd dist/.deps && find . -type f | sed 's|^\./||'); do
        cp "dist/.deps/$manifest" "$manifest" || restored=0
    done
    if [ "$restored" -eq 1 ]; then
        # They are in the store already; the registry is asked only when they are not
        if run_install --offline || run_install; then
            lock_hash > "$INSTALL_MARKER"
        else
            restored=0
        fi
    fi
    # Back to the manifests of the commit that is checked out: the next start
    # compares the install marker against them and installs again.
    # shellcheck disable=SC2046
    git checkout --quiet HEAD -- $(dependency_manifests) || log "could not put the manifests of $COMMIT back"
    [ "$restored" -eq 1 ] || log "the packages of the previous build could not be put back; it starts with the ones just installed"
}

build_server() {
    log "compiling the server"
    rm -rf dist.next
    # Never incremental: a cache that outlives dist/ makes tsc emit nothing
    node_modules/.bin/tsc --noCheck --incremental false --outDir dist.next || return 1
    [ -f dist.next/index.js ] || { log "the compile left no dist.next/index.js"; return 1; }
    echo "$COMMIT" > dist.next/BUILD_COMMIT
    remember_dependencies || log "could not record the packages of this build"
}

build_webapp() {
    local tree wanted
    tree=$(git rev-parse HEAD:webapp 2>/dev/null)
    wanted="$tree $LOCK_HASH"
    if [ -n "$tree" ] && [ "$(cat "$WEBAPP_MARKER" 2>/dev/null)" = "$wanted" ]; then
        log "webapp unchanged, build skipped"
        return 0
    fi
    log "building the webapp"
    rm -rf webapp/dist.next
    WEBAPP_OUT_DIR=dist.next pnpm --filter ./webapp build || return 1
    [ -f webapp/dist.next/index.html ] || { log "the webapp build left no index.html"; return 1; }
    echo "$wanted" > webapp/dist.next/.build-hash
}

# Replaces "$1" with "$1.next" when the latter exists
swap_in() {
    [ -d "$1.next" ] || return 0
    rm -rf "$1.old"
    [ -d "$1" ] && mv "$1" "$1.old"
    mv "$1.next" "$1" && rm -rf "$1.old"
}

started_at=$(date +%s)
if install_dependencies && build_server && build_webapp; then
    # Only after both builds succeeded, so server and webapp stay a matching pair
    swap_in dist
    swap_in webapp/dist
    log "built $COMMIT in $(( $(date +%s) - started_at ))s"
else
    rm -rf dist.next webapp/dist.next
    if [ -f dist/index.js ]; then
        log "BUILD FAILED for $COMMIT; starting the previous build ($(cat dist/BUILD_COMMIT 2>/dev/null || echo unknown commit))"
        restore_previous_dependencies
    else
        log "BUILD FAILED for $COMMIT and there is no previous build to start"
        exit 1
    fi
fi

# pm2 comes with the image. A container created from an image that was built
# before pm2 moved into the Dockerfile does not have it: install it here, as the
# old start script did on every start, instead of failing in a loop.
if ! command -v pm2-runtime > /dev/null 2>&1; then
    log "pm2 is not in this image, installing it; rebuild the image (docker compose build k-on-bot)"
    npm install -g "pm2@${PM2_VERSION:-7.1.2}" || log "pm2 could not be installed"
fi

# exec: the process that runs the bot must receive the container's stop signal
if command -v pm2-runtime > /dev/null 2>&1; then
    exec pm2-runtime start scripts/deploy/pm2.config.cjs
fi
log "starting without pm2: a crash now restarts the container, which builds again"
exec node dist/index.js
