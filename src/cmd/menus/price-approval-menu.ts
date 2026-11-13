/**
 * The price watcher's approval buttons (`pricing:` callbacks, design §5.3).
 *
 * The watcher (or the owner's `/pricing`) sends a private message listing
 * pending price changes; these handlers apply or reject them and then rewrite
 * the message into the outcome, so a stale click cannot act twice. Only the
 * owner may press: the message lives in their chat, but a forwarded copy would
 * carry the buttons to everybody.
 */
import { InlineKeyboard } from 'grammy';
import type { Bot, Context } from 'grammy';
import { isOwnerUser } from '../../config/owner.js';
import { updateBotNotice } from '../../services/bot-notice-service.js';
import {
    applyProposals,
    findProposal,
    listPendingProposals,
    rejectProposals,
    type PriceProposalView,
} from '../../services/model-price-service.js';
import { to } from '../../shared/result.js';

/** Before the action: which proposals the press is about */
const PREFIX = 'pricing:';
const NOT_OWNER_NOTICE = '只有机主可以审批';
const WRITE_FAILED_NOTICE = '写入失败，见日志';
const ALREADY_DONE_NOTICE = '已处理';
const STALE_BUTTON_NOTICE = '按钮已失效';

/** The three buttons of one approval message */
type PriceApprovalAction =
    | { readonly kind: 'apply'; readonly id: number }
    | { readonly kind: 'apply-all' }
    | { readonly kind: 'reject-all' };

/** How a successful press ended, with the rows it was about */
interface ApprovalOutcome {
    readonly kind: 'applied' | 'rejected';
    /** Rows the service actually changed */
    readonly changed: number;
    /** Rows another press had already decided */
    readonly skipped: number;
    readonly targets: readonly PriceProposalView[];
}

const actionOf = (payload: string): PriceApprovalAction | null => {
    if (payload === 'all:apply') return { kind: 'apply-all' };
    if (payload === 'all:reject') return { kind: 'reject-all' };
    const apply = /^apply:(\d+)$/.exec(payload);
    const rawId = apply?.[1];
    if (rawId === undefined) return null;
    const id = Number(rawId);
    return Number.isSafeInteger(id) ? { kind: 'apply', id } : null;
};

const answer = async (ctx: Context, text: string): Promise<void> => {
    const [error] = await to(ctx.answerCallbackQuery({ text }));
    if (error) console.warn('[price-menu] the callback answer failed:', error.message);
};

/** The proposals a press would decide; an already-decided id yields none */
const targetsOf = async (action: PriceApprovalAction): Promise<readonly PriceProposalView[]> => {
    if (action.kind === 'apply') {
        const proposal = await findProposal(action.id);
        return proposal === null || proposal.status !== 'pending' ? [] : [proposal];
    }
    return listPendingProposals();
};

const decide = async (
    action: PriceApprovalAction,
    targets: readonly PriceProposalView[],
    actorId: number
): Promise<ApprovalOutcome> => {
    const ids = targets.map((target) => target.id);
    if (action.kind === 'reject-all') {
        const rejected = await rejectProposals(ids, actorId);
        return { kind: 'rejected', changed: rejected, skipped: ids.length - rejected, targets };
    }
    const applied = await applyProposals(ids, actorId);
    return { kind: 'applied', changed: applied.applied, skipped: applied.skipped, targets };
};

/** The row that replaces the buttons: what the press did */
const outcomeTextOf = (outcome: ApprovalOutcome): string => {
    const verb = outcome.kind === 'applied' ? '已应用' : '已忽略';
    const mark = outcome.kind === 'applied' ? '✅' : '❌';
    const names = outcome.targets.map((target) => `· ${target.model} · ${target.tier}`).join('\n');
    return `${mark} ${verb} ${outcome.changed} 条价格提案\n${names}`;
};

/** Rewrite the approval message into the outcome and drop its buttons */
const rewriteMessage = async (ctx: Context, text: string): Promise<void> => {
    // An empty keyboard is what removes the buttons; omitting reply_markup
    // leaves the old one in place
    const [editError] = await to(ctx.editMessageText(text, { reply_markup: new InlineKeyboard([]) }));
    if (editError) {
        console.warn('[price-menu] rewriting the approval message failed:', editError.message);
        return;
    }
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (messageId !== undefined) await updateBotNotice(ctx, messageId, text);
};

const handleApproval = async (ctx: Context, action: PriceApprovalAction): Promise<void> => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
        await ctx.answerCallbackQuery().catch(() => undefined);
        return;
    }
    if (!isOwnerUser(userId)) {
        await answer(ctx, NOT_OWNER_NOTICE);
        return;
    }

    const [lookupError, targets] = await to(targetsOf(action));
    if (lookupError) {
        console.error('[price-menu] reading the pending proposals failed:', lookupError);
        await answer(ctx, WRITE_FAILED_NOTICE);
        return;
    }
    if (targets.length === 0) {
        await answer(ctx, ALREADY_DONE_NOTICE);
        return;
    }

    const [decideError, outcome] = await to(decide(action, targets, userId));
    if (decideError) {
        // The transaction rolled back: every proposal is still pending
        console.error('[price-menu] writing the owner\'s decision failed:', decideError);
        await answer(ctx, WRITE_FAILED_NOTICE);
        return;
    }
    if (outcome.changed === 0) {
        await answer(ctx, ALREADY_DONE_NOTICE);
        return;
    }

    const verb = outcome.kind === 'applied' ? '已应用' : '已忽略';
    await answer(ctx, `${verb} ${outcome.changed} 条`);
    await rewriteMessage(ctx, outcomeTextOf(outcome));
};

/** Register the `pricing:` half of the callback_query data handlers */
export const registerPriceApprovalCallbacks = (bot: Bot): void => {
    bot.on('callback_query:data', async (ctx, next) => {
        const data = ctx.callbackQuery.data;
        if (!data.startsWith(PREFIX)) return next();
        const action = actionOf(data.slice(PREFIX.length));
        if (action === null) {
            await answer(ctx, STALE_BUTTON_NOTICE);
            return;
        }
        await handleApproval(ctx, action);
    });
};
