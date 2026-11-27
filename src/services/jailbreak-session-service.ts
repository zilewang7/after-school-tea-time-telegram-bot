/**
 * Reply-tree scoped policy overrides (design 2026-1128-0045).
 *
 * A row exists only while a tree is under a jailbreak policy: `/jb` writes it,
 * `/jb off` removes it, and an expired row is ignored on read and swept on
 * startup. Reads are one indexed lookup per reply — the reply path must not
 * depend on a cache that a restart would have to rebuild.
 */
import { Op } from '@sequelize/core';
import { JailbreakSessionRecord } from '../db/jailbreakSessionDTO.js';
import { ensurePromptTemplatesCacheLoaded, getPromptTemplate } from './prompt-templates-cache.js';

/** How long a `/jb` tree stays active without being refreshed */
export const JAILBREAK_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface JailbreakSession {
    readonly chatId: number;
    readonly rootMessageId: number;
    readonly profileId: number;
    readonly model: string | null;
    readonly createdBy: number;
    readonly expiresAt: Date;
}

export interface RegisterJailbreakSessionInput {
    readonly chatId: number;
    readonly rootMessageId: number;
    readonly profileId: number;
    readonly model?: string | null;
    readonly createdBy: number;
    /** Defaults to `JAILBREAK_SESSION_TTL_MS` from now */
    readonly ttlMs?: number;
}

const toSession = (row: JailbreakSessionRecord): JailbreakSession => ({
    chatId: row.chatId,
    rootMessageId: row.rootMessageId,
    profileId: row.profileId,
    model: row.model ?? null,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt,
});

/** The tree's active policy row, or null when it has none or it expired */
export const readJailbreakSession = async (
    chatId: number,
    rootMessageId: number,
    now: number = Date.now()
): Promise<JailbreakSession | null> => {
    const row = await JailbreakSessionRecord.findOne({ where: { chatId, rootMessageId } });
    if (!row) return null;
    if (row.expiresAt.getTime() <= now) return null;
    return toSession(row);
};

/** Create or refresh the tree's row (one tree, one policy) */
export const registerJailbreakSession = async (input: RegisterJailbreakSessionInput): Promise<JailbreakSession> => {
    const now = Date.now();
    const expiresAt = new Date(now + (input.ttlMs ?? JAILBREAK_SESSION_TTL_MS));
    const [row] = await JailbreakSessionRecord.upsert({
        chatId: input.chatId,
        rootMessageId: input.rootMessageId,
        profileId: input.profileId,
        model: input.model ?? null,
        createdBy: input.createdBy,
        createdAt: new Date(now),
        expiresAt,
    });
    return toSession(row);
};

export const clearJailbreakSession = async (chatId: number, rootMessageId: number): Promise<boolean> => {
    const removed = await JailbreakSessionRecord.destroy({ where: { chatId, rootMessageId } });
    return removed > 0;
};

/** Active trees of one chat, oldest first; expired rows are filtered out */
export const listJailbreakSessions = async (
    chatId: number,
    now: number = Date.now()
): Promise<readonly JailbreakSession[]> => {
    const rows = await JailbreakSessionRecord.findAll({ where: { chatId }, order: [['rootMessageId', 'ASC']] });
    return rows.filter((row) => row.expiresAt.getTime() > now).map(toSession);
};

/** Drop expired rows; called once at startup, returns how many went away */
export const sweepExpiredJailbreakSessions = async (now: number = Date.now()): Promise<number> =>
    JailbreakSessionRecord.destroy({ where: { expiresAt: { [Op.lte]: new Date(now) } } });

/** The policy text of one session, from the prompt-templates cache */
export const jailbreakPolicyText = async (session: JailbreakSession): Promise<string | null> => {
    await ensurePromptTemplatesCacheLoaded();
    const template = getPromptTemplate(session.profileId);
    if (!template || !template.enabled) return null;
    return template.content;
};
