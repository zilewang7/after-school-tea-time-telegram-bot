/**
 * settings_audit rows as the API returns them, with the actor's display name.
 */
import type { SettingsAuditEntry } from '../../db/queries/settings-audit.js';
import { displayNameOf, lookupDisplayNames } from './display-names.js';

export interface AuditEntryView {
    id: number;
    actorId: number;
    actorName: string;
    scope: string;
    key: string;
    oldValue: string | null;
    newValue: string | null;
    createdAt: string;
}

/** The chat dashboard's short form: the scope is implied by the chat */
export type ChatAuditEntryView = Omit<AuditEntryView, 'scope'>;

export const toAuditEntryViews = async (entries: readonly SettingsAuditEntry[]): Promise<AuditEntryView[]> => {
    const names = await lookupDisplayNames(entries.map((entry) => entry.actorId));
    return entries.map((entry) => ({
        id: entry.id,
        actorId: entry.actorId,
        actorName: displayNameOf(names, entry.actorId),
        scope: entry.scope,
        key: entry.key,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        createdAt: entry.createdAt.toISOString(),
    }));
};

export const withoutScope = (entry: AuditEntryView): ChatAuditEntryView => ({
    id: entry.id,
    actorId: entry.actorId,
    actorName: entry.actorName,
    key: entry.key,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    createdAt: entry.createdAt,
});
