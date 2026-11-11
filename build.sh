#!/bin/bash
#
# Stage 1 of the container start: bring the checkout to the newest commit,
# then hand over to that commit's start script.
#
# Kept this small on purpose. Bash goes on running the copy of this file it
# started with, so anything else placed here would run one release behind.
# All build logic lives in scripts/deploy/start.sh.

cd /app/k-on-bot || exit 1

# DEPLOY_BRANCH exists for rehearsals in a throwaway container
branch="${DEPLOY_BRANCH:-master}"

# A failed fetch (GitHub unreachable) must not keep the bot down: start what is here
if git fetch origin "$branch" && git reset --hard FETCH_HEAD; then
    git clean -fd
else
    echo "[deploy] fetch of $branch failed, starting the code already in the container" >&2
fi

exec /bin/bash scripts/deploy/start.sh
