#!/bin/bash
#
# Rehearses the container start scripts (build.sh, scripts/deploy/start.sh) in
# throwaway containers, so a change to them is never tried out on production.
#
#   bash scripts/deploy/rehearse.sh           run every scenario
#   bash scripts/deploy/rehearse.sh --tests   also run the offline suite inside the container
#   bash scripts/deploy/rehearse.sh --clean   also remove the rehearsal image and volumes
#   bash scripts/deploy/rehearse.sh --from-production
#                                             start from a copy of production's packages
#
# It builds an image from the Dockerfile, then plays "origin" with a local
# clone of the commit checked out here (it must be committed). Without
# --from-production nothing of production is mounted: no database, no .env,
# no production volume.
#
# --from-production is for a change of the image (Node, pnpm): a recreated
# production container meets the packages its old image installed, and with no
# earlier build to fall back to a failed install there keeps the bot down. The
# flag copies production's node_modules and pnpm store volumes (mounted
# read-only for the copy, packages only) into the rehearsal volumes, so the
# first start below is the one production is about to make.
#
# Scenarios, in one container that is restarted like production is:
#   1. first start        full install and build
#   2. restart, no change install and webapp build skipped
#   3. a broken commit    the previous build keeps running, BUILD_COMMIT unchanged
#   4. the fix            builds again
#   5. origin unreachable starts the code it has
#   6. the compiled bot   every module loads on this image, sqlite included, and
#                         the database path default only applies inside a container
#   7. the offline suite  only with --tests: the image's Node and libc run every case
#   8. an image without pm2 (one built before pm2 moved into the Dockerfile)
#                         pm2 is installed at start instead of failing in a loop
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
# Named by compose after the directory of the main checkout
PRODUCTION_MODULES_VOLUME=${PRODUCTION_MODULES_VOLUME:-k-on-bot_k-on-bot-node-modules}
PRODUCTION_STORE_VOLUME=${PRODUCTION_STORE_VOLUME:-k-on-bot_k-on-bot-pnpm-store}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/k-on-bot-rehearsal-XXXXXX")
ORIGIN="$WORK/origin"
GIT_REPO=https://github.com/zilewang7/after-school-tea-time-telegram-bot.git
START_TIMEOUT_SECONDS=${START_TIMEOUT_SECONDS:-1200}

RUN_TESTS=0
CLEAN_AFTERWARDS=0
FROM_PRODUCTION=0
for argument in "$@"; do
    case "$argument" in
        --tests) RUN_TESTS=1 ;;
        --clean) CLEAN_AFTERWARDS=1 ;;
        --from-production) FROM_PRODUCTION=1 ;;
        *) echo "usage: bash scripts/deploy/rehearse.sh [--tests] [--clean] [--from-production]"; exit 2 ;;
    esac
done

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
# To the nanosecond: rounded down to a second, the window would reach back to the
# hand-over line of the start before, and the wait would end before this start began
timestamp_now() { date -u +%Y-%m-%dT%H:%M:%S.%NZ; }

# Waits until the start script handed over: by default to the stand-in for pm2,
# which then reports itself; $2 names another log line to wait for
wait_for_start() {
    local since=$1 handed_over=${2:-} deadline=$(( $(date +%s) + START_TIMEOUT_SECONDS ))
    # Assigned on its own line: as a default inside the expansion the backslashes would be eaten
    # and the pattern would turn into a bracket expression that matches any line
    [ -n "$handed_over" ] || handed_over='\[stand-in pm2\]'
    until logs_since_start "$since" | grep -q "$handed_over"; do
        if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
            echo "  container exited:"; logs_since_start "$since" | tail -20; return 1
        fi
        [ "$(date +%s)" -lt "$deadline" ] || { echo "  timed out:"; logs_since_start "$since" | tail -20; return 1; }
        sleep 2
    done
}

restart_and_wait() {
    local since
    since=$(timestamp_now)
    docker restart -t 5 "$CONTAINER" > /dev/null
    wait_for_start "$since" || fail "the container did not reach the start of the bot"
    LAST_LOGS=$(logs_since_start "$since")
}

# Replaces the volume "$2" with the content of "$1", which is only read
copy_volume() {
    docker volume inspect "$1" > /dev/null 2>&1 || return 1
    docker volume rm "$2" > /dev/null 2>&1
    docker run --rm -v "$1:/from:ro" -v "$2:/to" "$IMAGE" sh -c 'cp -a /from/. /to/'
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

docker rm -f "$CONTAINER" > /dev/null 2>&1
if [ "$FROM_PRODUCTION" -eq 1 ]; then
    step "copying production's packages into the rehearsal volumes"
    copy_volume "$PRODUCTION_MODULES_VOLUME" "$MODULES_VOLUME" || { echo "could not copy $PRODUCTION_MODULES_VOLUME"; exit 1; }
    copy_volume "$PRODUCTION_STORE_VOLUME" "$STORE_VOLUME" || { echo "could not copy $PRODUCTION_STORE_VOLUME"; exit 1; }
    pass "copied (production's volumes were mounted read-only)"
fi

step "1. first start"
since=$(timestamp_now)
# The image holds a clone of GitHub master. Point it at the local origin and
# take the first step by hand, then build.sh does what it does in production.
# Only on the first start: a restart runs this command again, and scenario 5
# needs the remote to stay broken.
docker run -d --init --name "$CONTAINER" \
    -v "$ORIGIN/.git:/origin.git:ro" \
    -v "$WORK/bin:/rehearsal-bin:ro" \
    -v "$MODULES_VOLUME:/app/k-on-bot/node_modules" \
    -v "$STORE_VOLUME:/root/.local/share/pnpm/store" \
    -e DEPLOY_BRANCH=rehearsal \
    -e PATH=/rehearsal-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$IMAGE" /bin/bash -c "git config --global --add safe.directory '*' \
        && { [ -f /rehearsal-prepared ] || { git remote set-url origin /origin.git \
            && git fetch --quiet origin rehearsal && git reset --quiet --hard FETCH_HEAD \
            && touch /rehearsal-prepared; }; } \
        && exec /bin/bash build.sh" > /dev/null || exit 1
wait_for_start "$since" || { fail "first start"; exit 1; }
LAST_LOGS=$(logs_since_start "$since")
check "built $GOOD_COMMIT" 'echo "$LAST_LOGS" | grep -q "\[deploy\] built $GOOD_COMMIT"'
check "BUILD_COMMIT is $GOOD_COMMIT" '[ "$(in_container cat dist/BUILD_COMMIT)" = "$GOOD_COMMIT" ]'
check "server and webapp output exist" 'in_container test -f dist/index.js && in_container test -f webapp/dist/index.html'
check "the check tools were not installed" '! in_container test -d tools/checks/node_modules/typescript'
check "pm2 is started through the config" 'echo "$LAST_LOGS" | grep -q "stand-in pm2\] start scripts/deploy/pm2.config.cjs"'
if [ "$failures" -gt 0 ]; then
    # Everything below builds on this start: show what happened and stop
    echo "  the first start did not produce a build; its log:"
    echo "$LAST_LOGS" | tail -60 | sed 's/^/    /'
    exit "$failures"
fi
COLD_FILE_COUNT=$(dist_file_count)
echo "  dist holds $COLD_FILE_COUNT files"
echo "  $(echo "$LAST_LOGS" | grep '\[deploy\] built')"

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

step "6. the compiled bot loads on this image"
# Placeholders for what the AI platforms want at import; no token, so the bot
# stops right after every module has loaded.
BOOT_OUTPUT=$(in_container env DB_PATH=/tmp/rehearsal-boot.sqlite GEMINI_API_KEY=x OPENAI_API_KEY=x \
    DEEPSEEK_API_KEY=x GROK_API_KEY=x MIMO_API_KEY=x node dist/index.js 2>&1 | tail -30)
check "every module loads; the bot stops at the missing token" 'echo "$BOOT_OUTPUT" | grep -q "BOT_TOKEN must be provided"'
echo "$BOOT_OUTPUT" | grep -q "BOT_TOKEN must be provided" || echo "$BOOT_OUTPUT" | sed 's/^/    /'
SQLITE_VERSION=$(in_container env DB_PATH=/tmp/rehearsal-query.sqlite node --input-type=module -e "
const { sequelize } = await import('/app/k-on-bot/dist/db/config.js');
const [rows] = await sequelize.query('SELECT sqlite_version() AS version');
console.log(rows[0].version);
await sequelize.close();" 2>&1 | tail -1)
check "sqlite answers a query (version $SQLITE_VERSION)" 'echo "$SQLITE_VERSION" | grep -Eq "^[0-9]+\.[0-9]+"'
IMPORT_DB_CONFIG="await import('/app/k-on-bot/dist/db/config.js')"
check "the container is marked by /.dockerenv" 'in_container test -f /.dockerenv'
check "without DB_PATH the production file is the default inside a container" 'in_container node --input-type=module -e "$IMPORT_DB_CONFIG" > /dev/null 2>&1'
check "the test instance must name its database" '! in_container env TEST_INSTANCE=1 node --input-type=module -e "$IMPORT_DB_CONFIG" > /dev/null 2>&1'

step "7. the offline suite on this image"
if [ "$RUN_TESTS" -eq 1 ]; then
    TEST_OUTPUT=$(in_container pnpm run --silent test:offline -j 2 2>&1)
    echo "$TEST_OUTPUT" | grep -v '^PASS  ' | sed 's/^/    /'
    check "every offline case passes on $(in_container node -v)" 'echo "$TEST_OUTPUT" | grep -q "^OK: "'
else
    echo "  skipped (run with --tests)"
fi

step "8. an image without pm2"
in_container git remote set-url origin /origin.git
# Neither the stand-in nor the pm2 of the image: what a container created from
# an image older than this Dockerfile looks like
rm -f "$WORK/bin/pm2-runtime"
in_container npm uninstall -g pm2 > /dev/null 2>&1
check "pm2 is gone" '! in_container sh -c "command -v pm2-runtime" > /dev/null 2>&1'
since=$(timestamp_now)
docker restart -t 5 "$CONTAINER" > /dev/null
# The real pm2 starts the real bot, which has no token here and exits; all
# that matters is that pm2 was installed and took over
wait_for_start "$since" 'PM2.*App \[k-on-bot' || fail "pm2 did not take over"
LAST_LOGS=$(logs_since_start "$since")
check "the missing pm2 is reported" 'echo "$LAST_LOGS" | grep -q "pm2 is not in this image"'
check "pm2 was installed and started the bot" 'echo "$LAST_LOGS" | grep -q "PM2.*App \[k-on-bot"'
docker rm -f "$CONTAINER" > /dev/null 2>&1

step "9. a stop signal reaches the app through init and the real pm2"
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

if [ "$CLEAN_AFTERWARDS" -eq 1 ]; then
    cleanup
    docker volume rm "$MODULES_VOLUME" "$STORE_VOLUME" > /dev/null 2>&1
    docker rmi "$IMAGE" > /dev/null 2>&1
fi

echo
if [ "$failures" -eq 0 ]; then echo "rehearsal passed"; else echo "rehearsal FAILED: $failures checks"; fi
exit "$failures"
