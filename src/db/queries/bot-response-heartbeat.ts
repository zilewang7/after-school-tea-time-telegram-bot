/**
 * The heartbeat of a reply being generated: `bot_responses.updatedAt` moves
 * forward while the row is still processing, so a long reply does not look
 * like a leftover to `deploy:check`, which treats an old processing row as
 * stale.
 *
 * A raw statement, for two reasons measured on the model: its static update()
 * writes nothing when updatedAt is the only value (0 rows, no error), and the
 * time must be in the format Sequelize itself writes (UTC with `+00:00`). The
 * Date goes in as a replacement, which Sequelize escapes in exactly that
 * format; SQL `datetime('now')` carries no zone and reads as hours old on a
 * host that is not on UTC.
 */
import { QueryTypes } from '@sequelize/core';
import { ButtonState } from '../botResponseDTO.js';
import { sequelize } from '../config.js';

/**
 * Move a processing reply's updatedAt to `at`. Only that column changes, and
 * only while the row is still processing: a finalized reply is left alone.
 * Returns the number of rows changed (0 or 1).
 */
export const touchProcessingBotResponse = async (
    chatId: number,
    firstMessageId: number,
    at: Date = new Date()
): Promise<number> => {
    const [, changedRows] = await sequelize.query(
        'UPDATE bot_responses SET updatedAt = :at WHERE chatId = :chatId AND messageId = :messageId AND buttonState = :processing',
        {
            type: QueryTypes.UPDATE,
            replacements: { at, chatId, messageId: firstMessageId, processing: ButtonState.PROCESSING },
        }
    );
    return changedRows;
};
