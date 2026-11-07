/**
 * The panel's reads of harness_issues: open counts for the chat list and the
 * chat an `i<issueId>` start target points into.
 */
import { QueryTypes } from '@sequelize/core';
import { sequelize } from '../../db/config.js';
import { HarnessIssue } from '../../db/harnessIssueDTO.js';
import { isJsonRecord } from '../json.js';

/** Open issues per chat; chats without any are absent */
export const countOpenIssuesByChat = async (): Promise<Map<number, number>> => {
    const rows: unknown[] = await sequelize.query(
        `SELECT chatId, COUNT(*) AS openCount
         FROM harness_issues
         WHERE status = 'open' AND chatId IS NOT NULL
         GROUP BY chatId`,
        { type: QueryTypes.SELECT }
    );
    const counts = new Map<number, number>();
    for (const row of rows) {
        if (!isJsonRecord(row)) continue;
        const chatId = Number(row.chatId);
        const openCount = Number(row.openCount);
        if (Number.isSafeInteger(chatId) && Number.isSafeInteger(openCount)) counts.set(chatId, openCount);
    }
    return counts;
};

/** null when the issue does not exist or belongs to no chat */
export const findIssueChatId = async (issueId: number): Promise<number | null> => {
    const issue = await HarnessIssue.findByPk(issueId, { attributes: ['id', 'chatId'] });
    return issue?.chatId ?? null;
};
