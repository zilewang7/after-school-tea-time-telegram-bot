#!/bin/bash
#
# Rehearses the container start scripts (build.sh, scripts/deploy/start.sh) in
# throwaway containers, so a change to them is never tried out on production.
#
#   bash scripts/deploy/rehearse.sh           run every scenario
#   bash scripts/deploy/rehearse.sh --clean   also remove the rehearsal image and volumes
#
# It builds an image from the Dockerfile, then plays "origin" with a local
# clone of the commit checked out here (it must be committed). Nothing of
# production is mounted: no database, no .env, no production volume.
#
# Scenarios, in one container that is restarted like production is:
#   1. first start        full install and build
#   2. restart, no change install and webapp build skipped
#   3. a broken commit    the previous build keeps running, BUILD_COMMIT unchanged
#   4. the fix            builds again
#   5. origin unreachable starts the code it has
# And with the real pm2: a stop signal reaches the app, which gets the time
# pm2.config.cjs grants it to finish.
#
# The first run compiles sqlite3 and takes several minutes; later runs reuse
# the rehearsal volumes.

set -u

REPOSITORY_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE=k-on-bot-rehearsal
CONTAINER=k-on-bot-rehearsal
SIGNAL_CONTAINER=k-on-bot-rehearsal-signal
MODULES_VOLUME=k-on-bot-rehearsal-node-modules
STORE_VOLUME=k-on-bot-rehearsal-pnpm-store
WORK=$(mktemp -d "${TMPDIR:-/tmp}/k-on-bot-rehearsal-XXXXXX")
ORIGIN="$WORK/origin"
GIT_REPO=https://github.com/zilewang7/after-school-tea-time-telegram-bot.git
START_TIMEOUT_SECONDS=${START_TIMEOUT_SECONDS:-1200}

failures=0
pass() { echo "  ok    $*"; }
fail() { echo "  FAIL  $*"; failures=$((failures + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
step() { echo; echo "== $* =="; }

cleanup() {
    docker rm -f "$CONTAINER" "$SIGNAL_CONTAINER" > /dev/null 2>&1
    rm -rf "$WORK"
}
trap cleanup EXIT

in_origin() { git -C "$ORIGIN" "$@"; }
in_container() { docker exec "$CONTAINER" "$@"; }
logs_since_start() { docker logs --since "$1" "$CONTAINER" 2>&1; }

# Waits until the stand-in for pm2 reports that the start script handed over
wait_for_start() {
    local since=$1 deadline=$(( $(date +%s) + START_TIMEOUT_SECONDS ))
    until logs_since_start "$since" | grep -q '\[stand-in pm2\]'; do
        if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
            echo "  container exited:"; logs_since_start "$since" | tail -20; return 1
        fi
        [ "$(date +%s)" -lt "$deadline" ] || { echo "  timed out:"; logs_since_start "$since" | tail -20; return 1; }
        sleep 2
    done
}

restart_and_wait() {
    local since
    since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    docker restart -t 5 "$CONTAINER" > /dev/null
    wait_for_start "$since" || fail "the container did not reach the start of the bot"
    LAST_LOGS=$(logs_since_start "$since")
}

dist_file_count() { in_container sh -c 'find dist -type f | wc -l' | tr -d ' '; }

step "preparing a local origin from $(git -C "$REPOSITORY_ROOT" rev-parse --short HEAD)"
if [ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=no)" ]; then
    echo "  note: uncommitted changes are not part of the rehearsal"
fi
git clone --quiet --no-hardlinks "$(git -C "$REPOSITORY_ROOT" rev-parse --git-common-dir)" "$ORIGIN" || exit 1
in_origin checkout --quiet -B rehearsal "$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)" || exit 1
in_origin config user.name rehearsal
in_origin config user.email rehearsal@localhost
GOOD_COMMIT=$(in_origin rev-parse --short HEAD)

mkdir -p "$WORK/bin" "$WORK/signal"
# Stands in for pm2-runtime in the build scenarios: the bot cannot start
# without a token, and what is under test is everything before it starts.
cat > "$WORK/bin/pm2-runtime" <<'EOF'
#!/bin/sh
echo "[stand-in pm2] $* (BUILD_COMMIT=$(cat dist/BUILD_COMMIT 2>/dev/null))"
exec sleep 86400
EOF
chmod +x "$WORK/bin/pm2-runtime"

step "building the image"
docker build --quiet -t "$IMAGE" --build-arg "GIT_REPO=$GIT_REPO" "$REPOSITORY_ROOT" > /dev/null || { echo "image build failed"; exit 1; }
pass "image built: node $(docker run --rm "$IMAGE" node -v), pnpm $(docker run --rm "$IMAGE" pnpm -v), pm2 $(docker run --rm "$IMAGE" pm2 -v | tail -1)"

step "1. first start"
docker rm -f "$CONTAINER" > /dev/null 2>&1
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# The image holds a clone of GitHub master. Point it at the local origin and
# take the first step by hand, then build.sh does what it does in production.
docker run -d --init --name "$CONTAINER" \
    -v "$ORIGIN/.git:/origin.git:ro" \
    -v "$WORK/bin:/rehearsal-bin:ro" \
    -v "$MODULES_VOLUME:/app/k-on-bot/node_modules" \
    -v "$STORE_VOLUME:/root/.local/share/pnpm/store" \
    -e DEPLOY_BRANCH=rehearsal \
    -e PATH=/rehearsal-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$IMAGE" /bin/bash -c "git config --global --add safe.directory '*' \
        && git remote set-url origin /origin.git \
        && git fetch --quiet origin rehearsal && git reset --quiet --hard FETCH_HEAD \
        && exec /bin/bash build.sh" > /dev/null || exit 1
wait_for_start "$since" || { fail "first start"; exit 1; }
LAST_LOGS=$(logs_since_start "$since")
check "built $GOOD_COMMIT" 'echo "$LAST_LOGS" | grep -q "\[deploy\] built $GOOD_COMMIT"'
check "BUILD_COMMIT is $GOOD_COMMIT" '[ "$(in_container cat dist/BUILD_COMMIT)" = "$GOOD_COMMIT" ]'
check "server and webapp output exist" 'in_container test -f dist/index.js && in_container test -f webapp/dist/index.html'
check "the check tools were not installed" '! in_container test -d tools/checks/node_modules/typescript'
check "pm2 is started through the config" 'echo "$LAST_LOGS" | grep -q "stand-in pm2\] start scripts/deploy/pm2.config.cjs"'
COLD_FILE_COUNT=$(dist_file_count)
echo "  dist holds $COLD_FILE_COUNT files"

step "2. restart without a new commit"
restart_and_wait
check "install skipped" 'echo "$LAST_LOGS" | grep -q "install skipped"'
check "webapp build skipped" 'echo "$LAST_LOGS" | grep -q "webapp unchanged"'
check "same number of files in dist" '[ "$(dist_file_count)" = "$COLD_FILE_COUNT" ]'
echo "  $(echo "$LAST_LOGS" | grep '\[deploy\] built')"

step "3. a commit that does not compile"
printf '\nconst broken = ;\n' >> "$ORIGIN/src/index.ts"
in_origin commit --quiet -am "rehearsal: a syntax error"
BROKEN_COMMIT=$(in_origin rev-parse --short HEAD)
restart_and_wait
check "the failure is logged with both commits" 'echo "$LAST_LOGS" | grep -q "BUILD FAILED for $BROKEN_COMMIT; starting the previous build ($GOOD_COMMIT)"'
check "BUILD_COMMIT still $GOOD_COMMIT" '[ "$(in_container cat dist/BUILD_COMMIT)" = "$GOOD_COMMIT" ]'
check "dist untouched" '[ "$(dist_file_count)" = "$COLD_FILE_COUNT" ]'
check "no staging directory left behind" '! in_container test -e dist.next && ! in_container test -e webapp/dist.next'
check "the bot is started anyway" 'echo "$LAST_LOGS" | grep -q "stand-in pm2\].*BUILD_COMMIT=$GOOD_COMMIT"'

step "4. the fix, with a webapp change"
in_origin revert --quiet --no-edit HEAD
printf '\n/* rehearsal */\n' >> "$ORIGIN/webapp/src/styles.css"
in_origin commit --quiet -am "rehearsal: a webapp change"
FIXED_COMMIT=$(in_origin rev-parse --short HEAD)
restart_and_wait
check "built $FIXED_COMMIT" 'echo "$LAST_LOGS" | grep -q "\[deploy\] built $FIXED_COMMIT"'
check "the webapp was rebuilt" 'echo "$LAST_LOGS" | grep -q "building the webapp"'
check "BUILD_COMMIT is $FIXED_COMMIT" '[ "$(in_container cat dist/BUILD_COMMIT)" = "$FIXED_COMMIT" ]'
check "same number of files in dist" '[ "$(dist_file_count)" = "$COLD_FILE_COUNT" ]'

step "5. origin unreachable"
in_container git remote set-url origin /nonexistent.git
restart_and_wait
check "the failed fetch is logged" 'echo "$LAST_LOGS" | grep -q "fetch of rehearsal failed"'
check "the bot is started with the build it has" 'echo "$LAST_LOGS" | grep -q "stand-in pm2\].*BUILD_COMMIT=$FIXED_COMMIT"'

step "6. a stop signal reaches the app through init and the real pm2"
# A stand-in app that needs 3s to shut down: longer than pm2's default 1.6s,
# shorter than the kill_timeout in pm2.config.cjs.
cat > "$WORK/signal/app.js" <<'EOF'
console.log('[stand-in app] up');
const shutdown = (signal) => {
    console.log(`[stand-in app] ${signal} received`);
    setTimeout(() => { console.log('[stand-in app] clean exit'); process.exit(0); }, 3000);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
setInterval(() => undefined, 1000);
EOF
node -e "
const config = require('$REPOSITORY_ROOT/scripts/deploy/pm2.config.cjs');
const app = { ...config.apps[0], script: 'app.js', cwd: '/signal' };
require('fs').writeFileSync('$WORK/signal/pm2.config.cjs', 'module.exports = ' + JSON.stringify({ apps: [app] }) + ';');
"
docker rm -f "$SIGNAL_CONTAINER" > /dev/null 2>&1
docker run -d --init --name "$SIGNAL_CONTAINER" -v "$WORK/signal:/signal:ro" "$IMAGE" \
    /bin/bash -c "cd /signal && exec pm2-runtime start pm2.config.cjs" > /dev/null
for _ in $(seq 1 30); do docker logs "$SIGNAL_CONTAINER" 2>&1 | grep -q 'stand-in app\] up' && break; sleep 1; done
stop_started=$(date +%s)
docker stop -t 20 "$SIGNAL_CONTAINER" > /dev/null
stop_seconds=$(( $(date +%s) - stop_started ))
SIGNAL_LOGS=$(docker logs "$SIGNAL_CONTAINER" 2>&1)
check "the app received the signal" 'echo "$SIGNAL_LOGS" | grep -q "stand-in app\] SIG.* received"'
check "the app was allowed to finish (3s shutdown)" 'echo "$SIGNAL_LOGS" | grep -q "stand-in app\] clean exit"'
check "the stop took ${stop_seconds}s, well inside the 20s grace period" '[ "$stop_seconds" -lt 15 ]'

if [ "${1:-}" = "--clean" ]; then
    cleanup
    docker volume rm "$MODULES_VOLUME" "$STORE_VOLUME" > /dev/null 2>&1
    docker rmi "$IMAGE" > /dev/null 2>&1
fi

echo
if [ "$failures" -eq 0 ]; then echo "rehearsal passed"; else echo "rehearsal FAILED: $failures checks"; fi
exit "$failures"
