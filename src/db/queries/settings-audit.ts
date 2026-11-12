/**
 * settings_audit: who changed which setting, from what to what. Written by the
 * settings service (and later issue / exclusion writes), read by the panel.
 * Value formats are documented on the DTO.
 */
import { Op, type Transaction, type WhereOptions } from '@sequelize/core';
import { SettingsAudit } from '../settingsAuditDTO.js';

export interface SettingsAuditInput {
    actorId: number;
    /** chat:<chatId> | global | issue:<issueId> | access:<applicationId> | user-access:<userId> */
    scope: string;
    key: string;
    oldValue: string | null;
    newValue: string | null;
}

export interface SettingsAuditEntry extends SettingsAuditInput {
    id: number;
    createdAt: Date;
}

export interface ListSettingsAuditOptions {
    /** Only this scope; all scopes when absent */
    scope?: string;
    limit: number;
    /** Page cursor: only rows with a smaller id */
    beforeId?: number;
}

/** Audit scope of one chat's settings */
export const chatAuditScope = (chatId: number): string => `chat:${chatId}`;

export const GLOBAL_AUDIT_SCOPE = 'global';

export const writeSettingsAudit = async (
    input: SettingsAuditInput,
    options: { transaction?: Transaction } = {}
): Promise<void> => {
    await SettingsAudit.create(
        {
            actorId: input.actorId,
            scope: input.scope,
            key: input.key,
            oldValue: input.oldValue,
            newValue: input.newValue,
            createdAt: new Date(),
        },
        { transaction: options.transaction }
    );
};

/** Newest first; ids grow with time, so id order is creation order */
export const listSettingsAudit = async (options: ListSettingsAuditOptions): Promise<SettingsAuditEntry[]> => {
    const where: WhereOptions<SettingsAudit> = {
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        ...(options.beforeId !== undefined ? { id: { [Op.lt]: options.beforeId } } : {}),
    };
    const rows = await SettingsAudit.findAll({
        where,
        order: [['id', 'DESC']],
        limit: options.limit,
    });
    return rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        scope: row.scope,
        key: row.key,
        oldValue: row.oldValue,
        newValue: row.newValue,
        createdAt: row.createdAt,
    }));
};
