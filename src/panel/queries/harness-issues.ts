/**
 * The panel's reads of harness_issues: open counts for the chat list, the
 * chat an `i<issueId>` start target points into, and the issue page.
 */
import { Op, QueryTypes } from '@sequelize/core';
import { sequelize } from '../../db/config.js';
import { HarnessIssue } from '../../db/harnessIssueDTO.js';
import {
    toHarnessIssueRecord,
    toHarnessIssueStats,
    type HarnessIssueKind,
    type HarnessIssueRecord,
    type HarnessIssueSeverity,
    type HarnessIssueSource,
    type HarnessIssueStats,
    type HarnessIssueStatus,
    type HarnessIssueStatusCount,
} from '../../services/harness-issue-service.js';
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

export interface PanelIssueFilters {
    readonly status?: HarnessIssueStatus;
    readonly kind?: HarnessIssueKind;
    readonly severity?: HarnessIssueSeverity;
    readonly source?: HarnessIssueSource;
    readonly chatId?: number;
    /** Found literally in the title or body (LIKE with its wildcards escaped) */
    readonly keyword?: string;
}

export interface PanelIssueQuery {
    /** null = every issue, those without a chat included (the owner); otherwise only these chats' */
    readonly visibleChatIds: readonly number[] | null;
    readonly filters: PanelIssueFilters;
    readonly limit: number;
    readonly offset: number;
}

export interface PanelIssuePage {
    /** Open issues first, then newest first */
    readonly records: readonly HarnessIssueRecord[];
    /** Issues matching every filter: what the pages add up to */
    readonly matched: number;
    /** Per-status counts of the visible issues under every filter except status */
    readonly stats: HarnessIssueStats;
}

/** SQLite LIKE has no escape character of its own; this one needs no quoting anywhere */
const LIKE_ESCAPE = '!';

const likePatternOf = (keyword: string): string =>
    `%${keyword.replace(/[!%_]/g, (character) => `${LIKE_ESCAPE}${character}`)}%`;

interface WhereClause {
    sql: string;
    replacements: Record<string, unknown>;
}

/** The visible scope plus the filters; `withStatus` false leaves the status filter out (for the counts) */
const buildWhere = (query: PanelIssueQuery, withStatus: boolean): WhereClause => {
    const conditions: string[] = [];
    const replacements: Record<string, unknown> = {};
    const { filters } = query;
    if (query.visibleChatIds !== null) {
        // Sequelize 7 does not expand arrays in replacements: one placeholder per chat
        const placeholders = query.visibleChatIds.map((chatId, index) => {
            const name = `visibleChatId${index}`;
            replacements[name] = chatId;
            return `:${name}`;
        });
        conditions.push(`chatId IN (${placeholders.join(', ')})`);
    }
    if (withStatus && filters.status !== undefined) {
        conditions.push('status = :status');
        replacements.status = filters.status;
    }
    if (filters.kind !== undefined) {
        conditions.push('kind = :kind');
        replacements.kind = filters.kind;
    }
    if (filters.severity !== undefined) {
        conditions.push('severity = :severity');
        replacements.severity = filters.severity;
    }
    if (filters.source !== undefined) {
        conditions.push('source = :source');
        replacements.source = filters.source;
    }
    if (filters.chatId !== undefined) {
        conditions.push('chatId = :chatId');
        replacements.chatId = filters.chatId;
    }
    if (filters.keyword !== undefined) {
        conditions.push(`(title LIKE :pattern ESCAPE '${LIKE_ESCAPE}' OR body LIKE :pattern ESCAPE '${LIKE_ESCAPE}')`);
        replacements.pattern = likePatternOf(filters.keyword);
    }
    return { sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', replacements };
};

const countByStatus = async (query: PanelIssueQuery): Promise<HarnessIssueStats> => {
    const where = buildWhere(query, false);
    const rows: unknown[] = await sequelize.query(
        `SELECT status, COUNT(*) AS issueCount FROM harness_issues ${where.sql} GROUP BY status`,
        { type: QueryTypes.SELECT, replacements: where.replacements }
    );
    const counts: HarnessIssueStatusCount[] = rows.flatMap((row) =>
        isJsonRecord(row) && typeof row.status === 'string' ? [{ status: row.status, count: Number(row.issueCount) }] : []
    );
    return toHarnessIssueStats(counts);
};

/** One page of ids in display order */
const pageIds = async (query: PanelIssueQuery): Promise<number[]> => {
    const where = buildWhere(query, true);
    const rows: unknown[] = await sequelize.query(
        `SELECT id FROM harness_issues ${where.sql}
         ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, createdAt DESC, id DESC
         LIMIT :limit OFFSET :offset`,
        {
            type: QueryTypes.SELECT,
            replacements: { ...where.replacements, limit: query.limit, offset: query.offset },
        }
    );
    return rows.flatMap((row) => (isJsonRecord(row) && typeof row.id === 'number' ? [row.id] : []));
};

const EMPTY_PAGE: PanelIssuePage = { records: [], matched: 0, stats: toHarnessIssueStats([]) };

/**
 * The issue page of one panel user: only `visibleChatIds` (all issues when
 * null), filtered, open first then newest first. Counts come from the same
 * scope, so nobody learns how many issues other chats have.
 */
export const listHarnessIssuesForPanel = async (query: PanelIssueQuery): Promise<PanelIssuePage> => {
    if (query.visibleChatIds !== null && query.visibleChatIds.length === 0) return EMPTY_PAGE;

    const [stats, ids] = await Promise.all([countByStatus(query), pageIds(query)]);
    const status = query.filters.status;
    const matched = status === undefined ? stats.total : stats.byStatus[status];
    if (ids.length === 0) return { records: [], matched, stats };

    // Rows through the model, so dates and defaults are typed; then back into page order
    const rows = await HarnessIssue.findAll({ where: { id: { [Op.in]: ids } } });
    const recordsById = new Map(rows.map((row) => [row.id, toHarnessIssueRecord(row)]));
    const records = ids.flatMap((id) => {
        const record = recordsById.get(id);
        return record === undefined ? [] : [record];
    });
    return { records, matched, stats };
};
