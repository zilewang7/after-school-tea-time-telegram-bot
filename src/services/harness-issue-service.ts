/**
 * Reads and writes for the harness issue list: friction the model logs about
 * the harness it is using, and issues people file from the control panel.
 *
 * The model's tools only insert and list. `status` and `note` are changed by
 * the owner from the panel (updateHarnessIssue), which is deliberately not a
 * tool: a model that can close its own issues would erase exactly the signal
 * we want to keep.
 */
import { Op, type InferAttributes, type WhereOptions } from '@sequelize/core';
import { sequelize } from '../db/config.js';
import { withBusyRetry } from '../db/busy-retry.js';
import { HarnessIssue } from '../db/harnessIssueDTO.js';
import { writeSettingsAudit } from '../db/queries/settings-audit.js';

export const HARNESS_ISSUE_KINDS = ['bug', 'improvement', 'feature'] as const;
export type HarnessIssueKind = (typeof HARNESS_ISSUE_KINDS)[number];

export const HARNESS_ISSUE_SEVERITIES = ['low', 'medium', 'high'] as const;
export type HarnessIssueSeverity = (typeof HARNESS_ISSUE_SEVERITIES)[number];

/** What a person triaging the list can set */
export const HARNESS_ISSUE_STATUSES = ['open', 'triaged', 'fixed', 'wontfix', 'duplicate'] as const;
export type HarnessIssueStatus = (typeof HARNESS_ISSUE_STATUSES)[number];

/** Who filed an issue: the model's tool, or a person from the panel */
export const HARNESS_ISSUE_SOURCES = ['model', 'user'] as const;
export type HarnessIssueSource = (typeof HARNESS_ISSUE_SOURCES)[number];

/** The model-facing filter: `closed` covers everything that is not open */
export const HARNESS_ISSUE_STATUS_FILTERS = ['open', 'closed', 'all'] as const;
export type HarnessIssueStatusFilter = (typeof HARNESS_ISSUE_STATUS_FILTERS)[number];

const OPEN_STATUSES: readonly string[] = ['open'];
const CLOSED_STATUSES: readonly string[] = ['triaged', 'fixed', 'wontfix', 'duplicate'];

export const HARNESS_ISSUE_TITLE_MAX = 200;
export const HARNESS_ISSUE_BODY_MAX = 4000;
export const HARNESS_ISSUE_NOTE_MAX = 4000;
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
    readonly note: string | null;
    readonly source: HarnessIssueSource;
    /** The filing person; null for the model's issues */
    readonly createdBy: number | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/** An issue the model files through its tool */
export interface CreateHarnessIssueInput {
    readonly title: string;
    readonly body: string;
    readonly kind: HarnessIssueKind;
    readonly severity?: HarnessIssueSeverity | null;
    readonly toolName?: string | null;
    readonly chatId?: number | null;
}

/** An issue a person files from the panel, already checked by parseHarnessIssueInput */
export interface CreateUserHarnessIssueInput {
    readonly title: string;
    readonly body: string;
    readonly kind: HarnessIssueKind;
    readonly severity: HarnessIssueSeverity | null;
    /** The chat it is filed on; the panel has checked the person can see it */
    readonly chatId: number;
    readonly userId: number;
}

export interface ListHarnessIssuesQuery {
    readonly status?: HarnessIssueStatusFilter;
    /** Keyword matched against title and body */
    readonly query?: string;
    readonly limit?: number;
    /**
     * The chat the caller replies in. Issues people filed on other chats stay
     * out of everything (rows, keyword hits, counts); the model's own issues
     * are always visible. Absent: the whole table.
     */
    readonly visibleInChatId?: number;
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

/** What the owner can change; an absent key stays as it is */
export interface HarnessIssuePatch {
    readonly status?: HarnessIssueStatus;
    /** Already normalized (normalizeHarnessIssueNote); null clears it */
    readonly note?: string | null;
}

interface HarnessIssueChange {
    key: keyof HarnessIssuePatch;
    oldValue: string | null;
    newValue: string | null;
}

/** settings_audit scope of one issue */
export const issueAuditScope = (issueId: number): string => `issue:${issueId}`;

export const toHarnessIssueRecord = (row: HarnessIssue): HarnessIssueRecord => ({
    id: row.id,
    status: row.status,
    kind: row.kind,
    severity: row.severity ?? null,
    title: row.title,
    body: row.body,
    toolName: row.toolName ?? null,
    chatId: row.chatId ?? null,
    note: row.note ?? null,
    // The column defaults to 'model'; anything else is not a person
    source: row.source === 'user' ? 'user' : 'model',
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

export const isHarnessIssueStatus = (value: string): value is HarnessIssueStatus =>
    HARNESS_ISSUE_STATUSES.some((status) => status === value);

const statusesFor = (filter: HarnessIssueStatusFilter): readonly string[] => {
    if (filter === 'all') return [...OPEN_STATUSES, ...CLOSED_STATUSES];
    return filter === 'closed' ? CLOSED_STATUSES : OPEN_STATUSES;
};

/** How many issues have one status */
export interface HarnessIssueStatusCount {
    readonly status: string;
    readonly count: number;
}

/** Stats from per-status counts; the total includes statuses outside the known five */
export const toHarnessIssueStats = (counts: Iterable<HarnessIssueStatusCount>): HarnessIssueStats => {
    const byStatus: Record<HarnessIssueStatus, number> = {
        open: 0,
        triaged: 0,
        fixed: 0,
        wontfix: 0,
        duplicate: 0,
    };
    let total = 0;
    for (const { status, count } of counts) {
        total += count;
        if (isHarnessIssueStatus(status)) byStatus[status] += count;
    }
    return { total, byStatus };
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
    return toHarnessIssueRecord(row);
};

/**
 * File an issue for a person: the row (source 'user', createdBy) and its
 * `create` audit entry are written together. Sends nothing anywhere: the
 * group notice is the panel route's job, after it has answered.
 */
export const createUserHarnessIssue = (input: CreateUserHarnessIssueInput): Promise<HarnessIssueRecord> =>
    withBusyRetry(
        () =>
            sequelize.transaction(async (transaction) => {
                const row = await HarnessIssue.create(
                    {
                        kind: input.kind,
                        title: input.title,
                        body: input.body,
                        severity: input.severity,
                        chatId: input.chatId,
                        source: 'user',
                        createdBy: input.userId,
                    },
                    { transaction }
                );
                await writeSettingsAudit(
                    {
                        actorId: input.userId,
                        scope: issueAuditScope(row.id),
                        key: 'create',
                        oldValue: null,
                        newValue: JSON.stringify({ chatId: input.chatId, kind: input.kind, title: input.title }),
                    },
                    { transaction }
                );
                return toHarnessIssueRecord(row);
            }),
        `harness issue by ${input.userId}`
    );

export const findHarnessIssue = async (issueId: number): Promise<HarnessIssueRecord | null> => {
    const row = await HarnessIssue.findByPk(issueId);
    return row === null ? null : toHarnessIssueRecord(row);
};

/** Issue updates run one at a time, so two edits never diff against the same row */
let updateQueue: Promise<unknown> = Promise.resolve();

const runSerialized = <T>(task: () => Promise<T>): Promise<T> => {
    const current = updateQueue.then(task);
    updateQueue = current.catch(() => undefined);
    return current;
};

/**
 * The owner's change of an issue's status and/or note, from the panel only
 * (never registered as a tool). `updatedAt` is set here: the table has no
 * automatic timestamps. Every changed key gets an audit entry (status: old /
 * new status; note: old / new full text or NULL). Unchanged values write
 * nothing. Resolves with the issue as it now is; null when it does not exist.
 */
export const updateHarnessIssue = (input: {
    issueId: number;
    patch: HarnessIssuePatch;
    actorId: number;
}): Promise<HarnessIssueRecord | null> =>
    runSerialized(() =>
        withBusyRetry(
            () =>
                sequelize.transaction(async (transaction) => {
                    const row = await HarnessIssue.findByPk(input.issueId, { transaction });
                    if (row === null) return null;

                    const changes: HarnessIssueChange[] = [];
                    const { status, note } = input.patch;
                    if (status !== undefined && status !== row.status) {
                        changes.push({ key: 'status', oldValue: row.status, newValue: status });
                        row.status = status;
                    }
                    const currentNote = row.note ?? null;
                    if (note !== undefined && note !== currentNote) {
                        changes.push({ key: 'note', oldValue: currentNote, newValue: note });
                        row.note = note;
                    }
                    if (changes.length === 0) return toHarnessIssueRecord(row);

                    row.updatedAt = new Date();
                    await row.save({ transaction });
                    for (const change of changes) {
                        await writeSettingsAudit(
                            { actorId: input.actorId, scope: issueAuditScope(row.id), ...change },
                            { transaction }
                        );
                    }
                    return toHarnessIssueRecord(row);
                }),
            `harness issue #${input.issueId}`
        )
    );

type HarnessIssueWhere = NonNullable<WhereOptions<InferAttributes<HarnessIssue>>>;

/** The model's view: its own issues plus those people filed on the chat it replies in */
const visibilityWhere = (visibleInChatId: number | undefined): HarnessIssueWhere =>
    visibleInChatId === undefined ? {} : { [Op.or]: [{ source: 'model' }, { chatId: visibleInChatId }] };

const countHarnessIssues = async (visibility: HarnessIssueWhere): Promise<HarnessIssueStats> => {
    const rows = await HarnessIssue.findAll({ attributes: ['status'], where: visibility });
    return toHarnessIssueStats(rows.map((row) => ({ status: row.status, count: 1 })));
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
    // Rows, keyword hits and counts all go through the same visibility predicate
    const visibility = visibilityWhere(query.visibleInChatId);

    const [rows, stats] = await Promise.all([
        HarnessIssue.findAll({
            where: {
                [Op.and]: [
                    visibility,
                    { status: { [Op.in]: [...statusesFor(filter)] } },
                    ...(keyword
                        ? [
                              {
                                  [Op.or]: [
                                      { title: { [Op.like]: `%${keyword}%` } },
                                      { body: { [Op.like]: `%${keyword}%` } },
                                  ],
                              },
                          ]
                        : []),
                ],
            },
            order: [['createdAt', 'DESC']],
            limit,
        }),
        countHarnessIssues(visibility),
    ]);
    return { records: rows.map(toHarnessIssueRecord), stats };
};

/** Test helper: wipe the table between cases */
export const clearHarnessIssues = async (): Promise<void> => {
    await HarnessIssue.destroy({ where: {} });
};
