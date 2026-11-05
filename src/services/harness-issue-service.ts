/**
 * Reads and writes for the harness issue list the model keeps about itself.
 *
 * The bot only inserts; `status` is advanced by people (or scripts) triaging
 * the list. There is no update/delete path here on purpose: a model that can
 * close its own issues would erase exactly the signal we want to keep.
 */
import { Op } from '@sequelize/core';
import { HarnessIssue } from '../db/harnessIssueDTO.js';

export const HARNESS_ISSUE_KINDS = ['bug', 'improvement', 'feature'] as const;
export type HarnessIssueKind = (typeof HARNESS_ISSUE_KINDS)[number];

export const HARNESS_ISSUE_SEVERITIES = ['low', 'medium', 'high'] as const;
export type HarnessIssueSeverity = (typeof HARNESS_ISSUE_SEVERITIES)[number];

/** What a person triaging the list can set */
export const HARNESS_ISSUE_STATUSES = ['open', 'triaged', 'fixed', 'wontfix', 'duplicate'] as const;
export type HarnessIssueStatus = (typeof HARNESS_ISSUE_STATUSES)[number];

/** The model-facing filter: `closed` covers everything that is not open */
export const HARNESS_ISSUE_STATUS_FILTERS = ['open', 'closed', 'all'] as const;
export type HarnessIssueStatusFilter = (typeof HARNESS_ISSUE_STATUS_FILTERS)[number];

const OPEN_STATUSES: readonly string[] = ['open'];
const CLOSED_STATUSES: readonly string[] = ['triaged', 'fixed', 'wontfix', 'duplicate'];

export const HARNESS_ISSUE_TITLE_MAX = 200;
export const HARNESS_ISSUE_BODY_MAX = 4000;
export const HARNESS_ISSUE_LIST_LIMIT_DEFAULT = 20;
export const HARNESS_ISSUE_LIST_LIMIT_MAX = 50;

export interface HarnessIssueRecord {
    readonly id: number;
    readonly status: string;
    readonly kind: string;
    readonly severity: string | null;
    readonly title: string;
    readonly body: string;
    readonly toolName: string | null;
    readonly chatId: number | null;
    readonly createdAt: Date;
}

export interface CreateHarnessIssueInput {
    readonly title: string;
    readonly body: string;
    readonly kind: HarnessIssueKind;
    readonly severity?: HarnessIssueSeverity | null;
    readonly toolName?: string | null;
    readonly chatId?: number | null;
}

export interface ListHarnessIssuesQuery {
    readonly status?: HarnessIssueStatusFilter;
    /** Keyword matched against title and body */
    readonly query?: string;
    readonly limit?: number;
}

/**
 * The whole list at a glance, independent of the filter and limit of the call.
 *
 * Without it a caller that gets zero rows cannot tell "nothing recorded yet"
 * from "nothing matches this filter" and asks again with another filter. The
 * counts answer both in one round trip.
 */
export interface HarnessIssueStats {
    readonly total: number;
    readonly byStatus: Readonly<Record<HarnessIssueStatus, number>>;
}

export interface ListHarnessIssuesResult {
    readonly records: readonly HarnessIssueRecord[];
    readonly stats: HarnessIssueStats;
}

const toRecord = (row: HarnessIssue): HarnessIssueRecord => ({
    id: row.id,
    status: row.status,
    kind: row.kind,
    severity: row.severity ?? null,
    title: row.title,
    body: row.body,
    toolName: row.toolName ?? null,
    chatId: row.chatId ?? null,
    createdAt: row.createdAt,
});

const statusesFor = (filter: HarnessIssueStatusFilter): readonly string[] => {
    if (filter === 'all') return [...OPEN_STATUSES, ...CLOSED_STATUSES];
    return filter === 'closed' ? CLOSED_STATUSES : OPEN_STATUSES;
};

export const createHarnessIssue = async (input: CreateHarnessIssueInput): Promise<HarnessIssueRecord> => {
    const row = await HarnessIssue.create({
        kind: input.kind,
        title: input.title,
        body: input.body,
        severity: input.severity ?? null,
        toolName: input.toolName ?? null,
        chatId: input.chatId ?? null,
    });
    return toRecord(row);
};

const isHarnessIssueStatus = (value: string): value is HarnessIssueStatus =>
    (HARNESS_ISSUE_STATUSES as readonly string[]).includes(value);

const countHarnessIssues = async (): Promise<HarnessIssueStats> => {
    const rows = await HarnessIssue.findAll({ attributes: ['status'] });
    const byStatus: Record<HarnessIssueStatus, number> = {
        open: 0,
        triaged: 0,
        fixed: 0,
        wontfix: 0,
        duplicate: 0,
    };
    for (const row of rows) {
        if (isHarnessIssueStatus(row.status)) byStatus[row.status] += 1;
    }
    return { total: rows.length, byStatus };
};

export const listHarnessIssues = async (
    query: ListHarnessIssuesQuery = {}
): Promise<ListHarnessIssuesResult> => {
    const filter = query.status ?? 'open';
    const limit = Math.min(
        Math.max(1, Math.trunc(query.limit ?? HARNESS_ISSUE_LIST_LIMIT_DEFAULT)),
        HARNESS_ISSUE_LIST_LIMIT_MAX
    );
    const keyword = query.query?.trim();

    const [rows, stats] = await Promise.all([
        HarnessIssue.findAll({
            where: {
                status: { [Op.in]: [...statusesFor(filter)] },
                ...(keyword
                    ? {
                          [Op.or]: [
                              { title: { [Op.like]: `%${keyword}%` } },
                              { body: { [Op.like]: `%${keyword}%` } },
                          ],
                      }
                    : {}),
            },
            order: [['createdAt', 'DESC']],
            limit,
        }),
        countHarnessIssues(),
    ]);
    return { records: rows.map(toRecord), stats };
};

/** Test helper: wipe the table between cases */
export const clearHarnessIssues = async (): Promise<void> => {
    await HarnessIssue.destroy({ where: {} });
};
