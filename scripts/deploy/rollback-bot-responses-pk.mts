/**
 * Reverse the bot_responses composite-key migration (design 2026-1123-1610 §7).
 *
 * The build that ships the composite key `(chatId, messageId)` cannot be rolled
 * back by checking out the previous commit alone: the old code upserts with a
 * `messageId` conflict target, which the new schema no longer has (every reply
 * creation would throw). Run this first, with the bot stopped so nothing writes
 * during the rebuild, then deploy the previous build and start the container.
 *
 * Rows a single-column key cannot express (two chats' replies that share a first
 * message id) are dropped: the newest row wins, the rest are reported. That is
 * the old schema's own limitation, not data this script invents or hides.
 *
 * Run inside the container (the host must never open database.sqlite):
 *   docker compose stop k-on-bot
 *   docker compose run --rm --entrypoint npx k-on-bot tsx scripts/deploy/rollback-bot-responses-pk.mts
 *   git checkout <previous-commit>
 *   docker compose build k-on-bot && docker compose up -d k-on-bot
 */
import { sequelize } from '../../src/db/config.js';
import { rollbackBotResponsesCompositeKey } from '../../src/db/schema-migrations.js';

const main = async (): Promise<void> => {
    const result = await rollbackBotResponsesCompositeKey();
    if (result.alreadySingle) {
        console.log('[rollback] bot_responses already has the single-column messageId primary key; nothing to do');
        return;
    }
    console.log(
        `[rollback] bot_responses rebuilt: rows=${result.rows}, dropped=${result.dropped}` +
            (result.dropped > 0
                ? ' (rows a single-column key cannot hold; the newest row per message id was kept)'
                : '')
    );
    console.log('[rollback] now deploy the previous build and start the container');
};

main()
    .catch((error: unknown) => {
        console.error('[rollback] failed:', error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => {
        void sequelize.close();
    });
