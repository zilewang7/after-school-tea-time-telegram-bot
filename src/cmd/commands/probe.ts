/**
 * `/probe import` & `/probe export`: owner-only probe workflow commands
 * (thinking-effort design 2026-1113-1742 §7, updated in 2026-1114-0510 §3.6).
 *
 * - `/probe export`: exports active enabled chat models from `model_catalog`
 *   (plus current standard prices) as JSON for `scripts/probe/thinking-effort.mts --models-json`.
 * - `/probe import`: downloads a replied v2 (or legacy v1) probe `results.json`
 *   document and queues capability proposals for owner approval.
 *
 * Hidden from the command menu and silent for anybody but the owner in a
 * private chat, like the other owner commands.
 */
import { InputFile, type Api, type Bot, type Context } from 'grammy';
import type { Document } from 'grammy/types';
import { findPriceAt } from '../../config/model-pricing.js';
import { isOwnerUser } from '../../config/owner.js';
import { notifyPendingCapabilityProposals } from '../../services/capability-proposal-notify.js';
import { upsertCapabilityProposal, type CapabilityProposalInput } from '../../services/model-capability-service.js';
import { listCatalogRows } from '../../services/model-catalog-service.js';
import { sendBotNotice } from '../../services/bot-notice-service.js';
import {
    PROBE_IMPORT_MAX_BYTES,
    PROBE_IMPORT_MIME_TYPE,
    buildProbeModelsExport,
    importProbeResultDocument,
    type ProbeCatalogModel,
    type ProbeImportPlan,
    type ProbeImportRunResult,
    type ProbeResultDocument,
} from '../../services/probe-import-service.js';
import { downloadTelegramFile } from '../../services/telegram-file-service.js';

const USAGE_TEXT =
    '用法：\n' +
    '/probe export — 导出当前启用的对话模型清单 JSON（供 scripts/probe --models-json 使用）\n' +
    '/probe import — 回复一条带 probe 结果 JSON 文档的消息（schema 2 或兼容 v1，≤1 MB，application/json）';

const NO_DOCUMENT_TEXT = '请回复一条带 JSON 文档的消息再发送 /probe import（文档类型必须是 application/json）。';
const DOWNLOAD_FAILED_TEXT = '下载文档失败，详见日志；没有写入任何数据。';
const IMPORT_FAILED_TEXT = '导入中途失败，可能有部分能力提案已写入；详见日志，重新导入同一文档会刷新它们。';
const EXPORT_EMPTY_TEXT = '当前目录中没有启用的对话模型可导出。';
const EXPORT_FAILED_TEXT = '导出模型清单失败，详见日志。';
const REJECTED_HEADER = 'probe 导入被拒绝，未写入任何数据：';
const MAX_REPORTED_REJECTIONS = 5;

/** What the command needs from the outside; tests replace the I/O sides */
export interface ProbeCommandDependencies {
    readonly readDocumentBytes: (api: Api, fileId: string) => Promise<Buffer>;
    readonly listCatalogModels: () => Promise<readonly ProbeCatalogModel[]>;
    readonly priceOfModel: (model: string) => { readonly inputPerM: number; readonly outputPerM: number } | null;
    readonly upsertProposal: (input: CapabilityProposalInput) => Promise<number>;
    readonly notifyPendingProposals: (bot: Bot) => Promise<number>;
}

const defaultDependencies = (): ProbeCommandDependencies => ({
    readDocumentBytes: async (api, fileId) => (await downloadTelegramFile({ api }, fileId)).bytes,
    listCatalogModels: async () => {
        const entries = await listCatalogRows();
        return entries.map((entry) => ({ model: entry.id, enabled: entry.enabled, capabilities: entry.capabilities }));
    },
    priceOfModel: (model) => findPriceAt(model, new Date()),
    upsertProposal: upsertCapabilityProposal,
    notifyPendingProposals: notifyPendingCapabilityProposals,
});

const sizeTextOf = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The text after `/probe`, lowercased; a non-text context has none */
const argumentOf = (ctx: Context): string => (typeof ctx.match === 'string' ? ctx.match.trim().toLowerCase() : '');

const documentOf = (ctx: Context): Document | null => ctx.message?.reply_to_message?.document ?? null;

/** Download with the command's size gate; returns null after answering why not */
const readDocument = async (
    ctx: Context,
    document: Document,
    dependencies: ProbeCommandDependencies
): Promise<Buffer | null> => {
    if (document.mime_type !== PROBE_IMPORT_MIME_TYPE) {
        await sendBotNotice(ctx, `只接受 ${PROBE_IMPORT_MIME_TYPE} 文档（这份是 ${document.mime_type ?? '未知类型'}）。`);
        return null;
    }
    if (document.file_size !== undefined && document.file_size > PROBE_IMPORT_MAX_BYTES) {
        await sendBotNotice(ctx, `文档 ${sizeTextOf(document.file_size)}，超过 1 MB 上限。`);
        return null;
    }
    try {
        const bytes = await dependencies.readDocumentBytes(ctx.api, document.file_id);
        if (bytes.length === 0) {
            await sendBotNotice(ctx, '文档是空的。');
            return null;
        }
        if (bytes.length > PROBE_IMPORT_MAX_BYTES) {
            await sendBotNotice(ctx, `文档实际 ${sizeTextOf(bytes.length)}，超过 1 MB 上限。`);
            return null;
        }
        return bytes;
    } catch (error: unknown) {
        console.error('[probe] downloading the import document failed:', error);
        await sendBotNotice(ctx, DOWNLOAD_FAILED_TEXT);
        return null;
    }
};

const laneSummaryOf = (document: ProbeResultDocument): string => {
    if (document.schema === 1) return document.laneSignature;
    const entries = Object.entries(document.lanes).map(([platform, lane]) => `${platform}=${lane}`);
    return entries.length > 0 ? entries.join(', ') : '未记录';
};

const summaryTextOf = (input: {
    readonly document: ProbeResultDocument;
    readonly plan: ProbeImportPlan;
    readonly notified: number;
    readonly notifyFailed: boolean;
}): string => {
    const { plan } = input;
    const lines: string[] = [];
    lines.push(`probe 导入完成（schema v${input.document.schema}，lane ${laneSummaryOf(input.document)}，${input.document.probedAt.slice(0, 10)}）`);
    lines.push(
        `导入 ${input.document.results.length} 个模型，生成 ${plan.proposals.length} 条能力提案；无变化 ${plan.unchanged.length} 个，跳过 ${plan.skipped.length} 个。`
    );
    if (plan.skipped.length > 0) {
        const shown = plan.skipped.slice(0, MAX_REPORTED_REJECTIONS).map((skip) => `${skip.model}（${skip.reason}）`);
        const more = plan.skipped.length > shown.length ? ` 等 ${plan.skipped.length} 个` : '';
        lines.push(`跳过：${shown.join('；')}${more}`);
    }
    if (plan.proposals.length > 0) {
        if (input.notifyFailed) {
            lines.push('审批消息发送失败，提案已入库；重新导入同一文档会再次发送。');
        } else if (input.notified > 0) {
            lines.push(`审批消息已发送（${input.notified} 条），点按钮应用或忽略。`);
        } else {
            lines.push('没有发送审批消息（未配置机主私聊？详见日志），提案已入库。');
        }
    }
    return lines.join('\n');
};

/** Parse, plan, queue proposals and tell the owner what happened */
const importDocument = async (
    ctx: Context,
    document: Document,
    bot: Bot,
    dependencies: ProbeCommandDependencies
): Promise<void> => {
    const bytes = await readDocument(ctx, document, dependencies);
    if (bytes === null) return;
    let result: ProbeImportRunResult;
    try {
        result = await importProbeResultDocument(bytes, {
            listCatalogModels: dependencies.listCatalogModels,
            upsertProposal: dependencies.upsertProposal,
        });
    } catch (error: unknown) {
        console.error('[probe] importing the probe result failed:', error);
        await sendBotNotice(ctx, IMPORT_FAILED_TEXT);
        return;
    }
    if (!result.ok) {
        const shown = result.errors.slice(0, MAX_REPORTED_REJECTIONS).map((problem) => `- ${problem}`);
        const more = result.errors.length > shown.length ? `\n…还有 ${result.errors.length - shown.length} 处` : '';
        await sendBotNotice(ctx, `${REJECTED_HEADER}\n${shown.join('\n')}${more}`);
        return;
    }
    let notified = 0;
    let notifyFailed = false;
    if (result.plan.proposals.length > 0) {
        try {
            notified = await dependencies.notifyPendingProposals(bot);
        } catch (error: unknown) {
            notifyFailed = true;
            console.error('[probe] sending the capability approval message failed:', error);
        }
    }
    await sendBotNotice(
        ctx,
        summaryTextOf({ document: result.document, plan: result.plan, notified, notifyFailed })
    );
};

/** Export active chat menu models as a JSON file for `--models-json` (§3.6) */
const exportModels = async (ctx: Context, dependencies: ProbeCommandDependencies): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    try {
        const catalog = await dependencies.listCatalogModels();
        const exported = buildProbeModelsExport(catalog, dependencies.priceOfModel);
        if (exported.length === 0) {
            await sendBotNotice(ctx, EXPORT_EMPTY_TEXT);
            return;
        }
        const unpricedCount = exported.filter((entry) => entry.price === undefined).length;
        const json = JSON.stringify(exported, null, 2);
        const dateStamp = new Date().toISOString().slice(0, 10);
        const caption =
            `已导出 ${exported.length} 个启用对话模型` +
            (unpricedCount > 0 ? `（其中 ${unpricedCount} 个暂无报价，probe 将使用兜底高价估算）` : '') +
            '；用 --models-json 传给 scripts/probe/thinking-effort.mts。';
        await ctx.api.sendDocument(chatId, new InputFile(Buffer.from(json, 'utf8'), `probe-models-${dateStamp}.json`), {
            caption,
        });
    } catch (error: unknown) {
        console.error('[probe] exporting the model matrix failed:', error);
        await sendBotNotice(ctx, EXPORT_FAILED_TEXT);
    }
};

const handleProbe = async (ctx: Context, bot: Bot, dependencies: ProbeCommandDependencies): Promise<void> => {
    // Owner, private chat; everybody else sees nothing (like /pricing)
    if (ctx.chat?.type !== 'private') return;
    const userId = ctx.from?.id;
    if (userId === undefined || !isOwnerUser(userId)) return;
    const subcommand = argumentOf(ctx);
    if (subcommand === 'export') {
        await exportModels(ctx, dependencies);
        return;
    }
    if (subcommand !== 'import') {
        await sendBotNotice(ctx, USAGE_TEXT);
        return;
    }
    const document = documentOf(ctx);
    if (document === null) {
        await sendBotNotice(ctx, NO_DOCUMENT_TEXT);
        return;
    }
    await importDocument(ctx, document, bot, dependencies);
};

/** Registered as a handler only: the command stays out of `setMyCommands` */
export const registerProbeCommand = (bot: Bot, overrides: Partial<ProbeCommandDependencies> = {}): void => {
    const dependencies: ProbeCommandDependencies = { ...defaultDependencies(), ...overrides };
    bot.command('probe', (ctx) => handleProbe(ctx, bot, dependencies));
};
