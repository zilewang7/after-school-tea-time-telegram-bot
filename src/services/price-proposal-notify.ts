/**
 * The price watcher's private-chat messages: the approval list with its inline
 * buttons, the models the watcher added to the menu, and the heartbeat notice
 * (pricing design 2026-1113-1150 §5.3).
 *
 * Everything here targets the owner's own chat, so the chat id is the owner
 * user id, and every send is fire-and-forget: a blocked bot, a rate limit or an
 * unreachable API is logged and the proposals stay pending for the next run.
 * Sends go through `runApiCall`, so they share the per-chat pace with the
 * streaming editor, and each one is stored as a bot row so later contexts see
 * what the owner was asked.
 */
import { InlineKeyboard } from 'grammy';
import type { Api } from 'grammy';
import { match } from 'ts-pattern';
import { concatMessages, type RenderedMessage } from 'telegram-md-entities';
import { priceTableVersion, type PriceEntry, type PriceSource, type PriceTier } from '../config/model-pricing.js';
import { getOwnerUserId } from '../config/owner.js';
import { writeBotMessageRow } from '../db/bot-message-row.js';
import { toApiEntities } from '../telegram/api-entities.js';
import { runApiCall } from '../telegram/edit-coordinator.js';
import { boldText, codeText, plainText } from '../telegram/formatters/entity-text.js';
import { attachProposalMessageIds, type PriceProposalView } from './model-price-service.js';

/** Telegram's practical limit for one approval message; the rest go to a follow-up */
const MAX_PROPOSALS_PER_MESSAGE = 8;

/** Button text has its own limit; long model ids are shortened */
const BUTTON_NAME_LIMIT = 24;

/** Callback data prefix the approval menu owns */
const CALLBACK_PREFIX = 'pricing:';

/** How a source name reads in the message */
const SOURCE_LABELS: Readonly<Record<PriceSource, string>> = {
    manual: '手工录入',
    'models-dev': 'models.dev',
    official: '官方价目',
    ephone: 'ephone',
};

/** Tier names are the code's own; the owner sees them in the table's terms */
const TIER_LABELS: Readonly<Record<PriceTier, string>> = {
    standard: 'standard',
    priority: 'priority',
};

const KIND_LABELS: Readonly<Record<PriceProposalView['kind'], string>> = {
    update: '更新',
    new_model: '新增模型',
    expiry: '到期提醒',
};

/** Where a batch sits in the run's whole proposal list */
interface BatchPlacement {
    /** 0-based index of the batch's first proposal */
    readonly start: number;
    /** Proposals the run wants approved, all messages together */
    readonly total: number;
}

const formatUsd = (value: number): string => `$${value}`;

/** The three numbers of one row, in the order the design prints them */
const priceTextOf = (entry: PriceEntry): string =>
    `输入 ${formatUsd(entry.inputPerM)} / 缓存 ${formatUsd(entry.cachedInputPerM)} / 输出 ${formatUsd(entry.outputPerM)}`;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** The instant an expiry reminder is about, when the proposal carries one */
const expiryDayOf = (proposal: PriceProposalView): string | null => {
    const end = proposal.effectiveTo ?? proposal.payload.effectiveTo ?? proposal.baseline?.effectiveTo;
    return end === undefined || end === null ? null : isoDay(end);
};

/** The price comparison the owner approves */
const detailTextOf = (proposal: PriceProposalView): string =>
    match(proposal.kind)
        .with('new_model', () => `   新 ${priceTextOf(proposal.payload)}`)
        .with('expiry', () => {
            const current = proposal.baseline ?? proposal.payload;
            const end = expiryDayOf(proposal);
            return `   现价 ${priceTextOf(current)}\n   ${end === null ? '到期' : `${end} 到期`}，没有后继价格`;
        })
        .with('update', () => {
            const baseline = proposal.baseline;
            return baseline === null
                ? `   新 ${priceTextOf(proposal.payload)}`
                : `   旧 ${priceTextOf(baseline)} → 新 ${priceTextOf(proposal.payload)}`;
        })
        .exhaustive();

/** Provenance and the day the row takes effect (or the reminder's day) */
const sourceTextOf = (proposal: PriceProposalView): string => {
    const entry = proposal.payload;
    const note = proposal.note === null ? '' : `，${proposal.note}`;
    const timing = proposal.kind === 'expiry' ? '到期提醒' : `${isoDay(proposal.effectiveFrom)} 起生效`;
    return `   来源 ${SOURCE_LABELS[entry.source]}（${entry.checkedOn}）${note}；${timing}`;
};

/** One numbered proposal: title, old → new, provenance */
const renderProposal = (index: number, proposal: PriceProposalView): RenderedMessage =>
    concatMessages(
        boldText(`${index}. ${proposal.model} · ${TIER_LABELS[proposal.tier]}`),
        plainText(`（${KIND_LABELS[proposal.kind]}）\n`),
        plainText(detailTextOf(proposal)),
        plainText('\n'),
        plainText(sourceTextOf(proposal))
    );

const headerTextOf = (placement: BatchPlacement, count: number): string => {
    const range =
        placement.total > MAX_PROPOSALS_PER_MESSAGE
            ? `第 ${placement.start + 1}–${placement.start + count} 条；`
            : '';
    return `💰 价目巡检：${placement.total} 条待确认（${range}价格表 ${priceTableVersion()}，USD/1M token）`;
};

/** One message: header, its proposals, and a note when another message follows */
const renderBatch = (
    batch: readonly PriceProposalView[],
    placement: BatchPlacement
): RenderedMessage => {
    const fragments: RenderedMessage[] = [boldText(headerTextOf(placement, batch.length)), plainText('\n\n')];
    for (const [offset, proposal] of batch.entries()) {
        fragments.push(renderProposal(placement.start + offset + 1, proposal));
        if (offset < batch.length - 1) fragments.push(plainText('\n\n'));
    }
    const remaining = placement.total - (placement.start + batch.length);
    if (remaining > 0) fragments.push(plainText(`\n\n还有 ${remaining} 条`));
    return concatMessages(...fragments);
};

const applyButtonLabel = (proposal: PriceProposalView): string => {
    const name =
        proposal.model.length <= BUTTON_NAME_LIMIT
            ? proposal.model
            : `${proposal.model.slice(0, BUTTON_NAME_LIMIT - 1)}…`;
    return `✅ 应用 #${proposal.id} ${name}`;
};

/** One row per proposal, then the all-or-nothing row */
const keyboardOf = (batch: readonly PriceProposalView[]): InlineKeyboard => {
    const keyboard = new InlineKeyboard();
    for (const [index, proposal] of batch.entries()) {
        // The empty keyboard already holds one row; only later buttons start one
        if (index > 0) keyboard.row();
        keyboard.text(applyButtonLabel(proposal), `${CALLBACK_PREFIX}apply:${proposal.id}`);
    }
    keyboard
        .row()
        .text('✅ 全部应用', `${CALLBACK_PREFIX}all:apply`)
        .text('❌ 全部忽略', `${CALLBACK_PREFIX}all:reject`);
    return keyboard;
};

/** Send one notice to the owner and store it; a failure is logged, never thrown */
const sendOwnerMessage = async (
    api: Api,
    ownerId: number,
    message: RenderedMessage,
    keyboard?: InlineKeyboard
): Promise<number | null> => {
    try {
        const sent = await runApiCall(ownerId, () =>
            api.sendMessage(ownerId, message.text, {
                entities: toApiEntities(message.entities),
                link_preview_options: { is_disabled: true },
                ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
            })
        );
        await writeBotMessageRow({
            chatId: ownerId,
            messageId: sent.message_id,
            replyToId: null,
            date: sent.date > 0 ? new Date(sent.date * 1000) : new Date(),
            text: message.text,
            modelParts: null,
            file: null,
            fileMime: null,
        }).catch((error: unknown) => {
            console.error('[price-notify] failed to store the notice row:', error);
        });
        return sent.message_id;
    } catch (error: unknown) {
        console.error(`[price-notify] sending a notice to the owner (${ownerId}) failed:`, error);
        return null;
    }
};

const batchesOf = (proposals: readonly PriceProposalView[]): readonly (readonly PriceProposalView[])[] => {
    const batches: PriceProposalView[][] = [];
    for (let index = 0; index < proposals.length; index += MAX_PROPOSALS_PER_MESSAGE) {
        batches.push(proposals.slice(index, index + MAX_PROPOSALS_PER_MESSAGE));
    }
    return batches;
};

const sendBatch = async (
    api: Api,
    ownerId: number,
    runId: number,
    batch: readonly PriceProposalView[],
    placement: BatchPlacement
): Promise<number | null> => {
    try {
        const message = renderBatch(batch, placement);
        const sent = await sendOwnerMessage(api, ownerId, message, keyboardOf(batch));
        if (sent === null) {
            console.error(`[price-notify] run ${runId}: no approval message for proposals ${batch.map((item) => item.id).join(',')}`);
            return null;
        }
        try {
            await attachProposalMessageIds(
                batch.map((item) => item.id),
                sent
            );
        } catch (error: unknown) {
            // The approval buttons still work; only the edit/resend pointer is lost
            console.error('[price-notify] failed to record the approval message id:', error);
        }
        return sent;
    } catch (error: unknown) {
        console.error(`[price-notify] run ${runId}: building the approval message failed:`, error);
        return null;
    }
};

/**
 * Ask the owner to approve the pending proposals, at most 8 per message. The
 * sends are best-effort: the returned list holds the messages that went out,
 * and the pending proposals are untouched.
 */
export const sendProposalMessage = async (
    api: Api,
    run: { readonly id: number },
    proposals: readonly PriceProposalView[]
): Promise<readonly number[]> => {
    if (proposals.length === 0) return [];
    const ownerId = getOwnerUserId();
    if (ownerId === null) return [];
    const messageIds: number[] = [];
    let start = 0;
    for (const batch of batchesOf(proposals)) {
        const sent = await sendBatch(api, ownerId, run.id, batch, { start, total: proposals.length });
        if (sent !== null) messageIds.push(sent);
        start += batch.length;
    }
    if (messageIds.length > 0) {
        console.log(
            `[price-notify] run ${run.id}: asked the owner about ${proposals.length} proposals in ${messageIds.length} message(s)`
        );
    }
    return messageIds;
};

/**
 * Tell the owner the watcher added models to the menu by itself. Their prices
 * still need approval, so this notice has no buttons.
 */
export const sendModelCatalogNotice = async (api: Api, added: readonly string[]): Promise<number | null> => {
    if (added.length === 0) return null;
    const ownerId = getOwnerUserId();
    if (ownerId === null) return null;
    const message = concatMessages(
        plainText('🆕 模型目录新增：'),
        codeText(added.join('、')),
        plainText('\n已自动加入模型菜单，价格待审批。')
    );
    return sendOwnerMessage(api, ownerId, message);
};

/** A plain private-chat notice (the watcher's 36-hour heartbeat) */
export const sendOwnerNotice = async (api: Api, text: string): Promise<number | null> => {
    if (text.trim().length === 0) return null;
    const ownerId = getOwnerUserId();
    if (ownerId === null) return null;
    return sendOwnerMessage(api, ownerId, plainText(text));
};
