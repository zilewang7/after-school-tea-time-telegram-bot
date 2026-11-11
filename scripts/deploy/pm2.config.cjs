// pm2 settings for the production container; started by scripts/deploy/start.sh.
//
// pm2 stays although docker could restart the process itself: a container
// restart runs the whole fetch-and-build again, so without pm2 every crash
// would deploy the newest master and cost a build's worth of downtime.
module.exports = {
    apps: [
        {
            name: 'k-on-bot',
            script: 'dist/index.js',
            cwd: '/app/k-on-bot',
            // On stop pm2 sends SIGINT and kills after this long. The default
            // (1.6s) is shorter than bot.stop(), which waits for one more
            // getUpdates round trip through the proxy to confirm what it handled.
            kill_timeout: 15000,
        },
    ],
};
