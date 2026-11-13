/**
 * The capability watcher's approval buttons (`catalog:` callbacks, thinking-effort
 * design 2026-1113-1742 §2.4).
 *
 * The watcher (or the owner's `/probe import`) sends a private message listing
 * pending capability changes; these handlers apply or reject them and then
 * rewrite the message into the outcome, so a stale click cannot act twice. Only
 * the owner may press: the message lives in their chat, but a forwarded copy
 * would carry the buttons to everybody.
 *
 * Every callback carries the `detectedAt` fingerprint of the payload it was
 * rendered for. A watch run refreshes a pending payload in place, so without
 * the fingerprint an old message's button would approve data the owner never
 * saw; a mismatch answers "提案已更新" and changes nothing.
 */
import { InlineKeyboard } from 'grammy';
import type { Bot, Context } from 'grammy';
import { isOwnerUser } from '../../config/owner.js';
import { updateBotNotice } from '../../services/bot-notice-service.js';
import {
    applyCapabilityProposals,
    capabilityFieldChangesOf,
    findCapabilityProposal,
    listPendingCapabilityProposals,
    rejectCapabilityProposals,
    type CapabilityApplyDecision,
    type CapabilityApplyResult,
    type CapabilityProposalView,
} from '../../services/model-capability-service.js';
import { to } from '../../shared/result.js';

/** Before the action: which proposals the press is about */
const PREFIX = 'catalog:';
const NOT_OWNER_NOTICE = '只有机主可以审批';
const WRITE_FAILED_NOTICE = '写入失败，见日志';
const ALREADY_DONE_NOTICE = '已处理';
const STALE_BUTTON_NOTICE = '按钮已失效';
const STALE_PROPOSAL_NOTICE = '提案已更新，请查看最新消息';
const DRIFTED_NOTICE = '数据已变化，请重新审批';
const UNCHANGED_NOTICE = '与当前一致';

/** The three buttons of one approval message, each with its payload fingerprint */
type CapabilityApprovalAction =
    | { readonly kind: 'apply'; readonly id: number; readonly detectedAtMs: number }
    | { readonly kind: 'apply-all'; readonly latestDetectedAtMs: number }
    | { readonly kind: 'reject-all'; readonly latestDetectedAtMs: number };

/** What a press may decide: the targets, or why there are none */
type PendingTargets =
    | { readonly kind: 'stale' }
    | { readonly kind: 'done' }
    | { readonly kind: 'pending'; readonly proposals: readonly CapabilityProposalView[] };

/** How a successful press ended, with the rows it was about */
type ApprovalOutcome =
    | {
          readonly kind: 'applied';
          readonly result: CapabilityApplyResult;
          readonly targets: readonly CapabilityProposalView[];
      }
    | {
          readonly kind: 'rejected';
          readonly rejected: number;
          readonly skipped: number;
          readonly targets: readonly CapabilityProposalView[];
      };

const actionOf = (payload: string): CapabilityApprovalAction | null => {
    const bulk = /^all:(apply|reject):(\d+)$/.exec(payload);
    if (bulk !== null) {
        const latestDetectedAtMs = Number(bulk[2]);
        if (!Number.isSafeInteger(latestDetectedAtMs) || latestDetectedAtMs <= 0) return null;
        return bulk[1] === 'apply'
            ? { kind: 'apply-all', latestDetectedAtMs }
            : { kind: 'reject-all', latestDetectedAtMs };
    }
    const apply = /^apply:(\d+):(\d+)$/.exec(payload);
    if (apply === null) return null;
    const id = Number(apply[1]);
    const detectedAtMs = Number(apply[2]);
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(detectedAtMs) || detectedAtMs <= 0) return null;
    return { kind: 'apply', id, detectedAtMs };
};

const answer = async (ctx: Context, text: string): Promise<void> => {
    const [error] = await to(ctx.answerCallbackQuery({ text }));
    if (error) console.warn('[capability-menu] the callback answer failed:', error.message);
};

const latestDetectedAtMsOf = (proposals: readonly CapabilityProposalView[]): number =>
    proposals.reduce((latest, proposal) => Math.max(latest, proposal.detectedAt.getTime()), 0);

/**
 * The proposals a press would decide. A payload refreshed after its message was
 * rendered answers `stale`: the message showed values the press would not write.
 */
const pendingTargetsOf = async (action: CapabilityApprovalAction): Promise<PendingTargets> => {
    if (action.kind === 'apply') {
        const proposal = await findCapabilityProposal(action.id);
        if (proposal === null || proposal.status !== 'pending') return { kind: 'done' };
        if (proposal.detectedAt.getTime() !== action.detectedAtMs) return { kind: 'stale' };
        return { kind: 'pending', proposals: [proposal] };
    }
    const pending = await listPendingCapabilityProposals();
    if (pending.length === 0) return { kind: 'done' };
    if (latestDetectedAtMsOf(pending) > action.latestDetectedAtMs) return { kind: 'stale' };
    return { kind: 'pending', proposals: pending };
};

const decide = async (
    action: CapabilityApprovalAction,
    targets: readonly CapabilityProposalView[],
    actorId: number
): Promise<ApprovalOutcome> => {
    const ids = targets.map((target) => target.id);
    if (action.kind === 'reject-all') {
        const rejected = await rejectCapabilityProposals(ids, actorId);
        return { kind: 'rejected', rejected, skipped: ids.length - rejected, targets };
    }
    const result = await applyCapabilityProposals(ids, actorId);
    return { kind: 'applied', result, targets };
};

/** The field labels of one proposal, shortened to what fits the outcome message */
const fieldLabelsOf = (proposal: CapabilityProposalView): string => {
    const changes = capabilityFieldChangesOf(proposal.payload, proposal.baseline);
    const labels = changes.slice(0, 2).map((change) => change.label).join('、');
    const more = changes.length > 2 ? ` 等 ${changes.length} 项` : '';
    return labels === '' ? '能力数据' : `${labels}${more}`;
};

/** One line per decided proposal, with what actually happened to it */
const decisionLineOf = (outcome: ApprovalOutcome, decision: CapabilityApplyDecision): string => {
    if (decision.outcome !== 'applied') {
        return decision.outcome === 'superseded'
            ? `· ${decision.model}：数据已变化，未应用，请重新审批`
            : `· ${decision.model}：与当前一致`;
    }
    const target = outcome.targets.find((candidate) => candidate.id === decision.id);
    const labels = target === undefined ? '能力数据' : fieldLabelsOf(target);
    return `· ${decision.model}（${labels}）：已应用`;
};

/** The row that replaces the buttons: only the rows the press actually decided */
const outcomeTextOf = (outcome: ApprovalOutcome): string => {
    if (outcome.kind === 'rejected') {
        const names = outcome.targets.map((target) => `· ${target.model}（${fieldLabelsOf(target)}）`).join('\n');
        return `❌ 已忽略 ${outcome.rejected} 条能力提案\n${names}`;
    }
    const { applied, superseded, unchanged, decisions } = outcome.result;
    const header =
        applied > 0
            ? `✅ 已应用 ${applied} 条能力提案`
            : superseded > 0
              ? '⚠️ 能力提案未写入：数据已变化'
              : 'ℹ️ 能力提案与当前一致';
    const notes: string[] = [];
    if (superseded > 0) notes.push(`数据已变化 ${superseded} 条`);
    if (unchanged > 0) notes.push(`与当前一致 ${unchanged} 条`);
    const lines = decisions.map((decision) => decisionLineOf(outcome, decision));
    return [header, ...notes, ...lines].join('\n');
};

/** Rewrite the approval message into the outcome and drop its buttons */
const rewriteMessage = async (ctx: Context, text: string): Promise<void> => {
    // An empty keyboard is what removes the buttons; omitting reply_markup
    // leaves the old one in place
    const [editError] = await to(ctx.editMessageText(text, { reply_markup: new InlineKeyboard([]) }));
    if (editError) {
        console.warn('[capability-menu] rewriting the approval message failed:', editError.message);
        return;
    }
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (messageId !== undefined) await updateBotNotice(ctx, messageId, text);
};

const handleApproval = async (ctx: Context, action: CapabilityApprovalAction): Promise<void> => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
        await ctx.answerCallbackQuery().catch(() => undefined);
        return;
    }
    if (!isOwnerUser(userId)) {
        await answer(ctx, NOT_OWNER_NOTICE);
        return;
    }

    const [lookupError, targets] = await to(pendingTargetsOf(action));
    if (lookupError) {
        console.error('[capability-menu] reading the pending proposals failed:', lookupError);
        await answer(ctx, WRITE_FAILED_NOTICE);
        return;
    }
    if (targets.kind === 'stale') {
        await answer(ctx, STALE_PROPOSAL_NOTICE);
        return;
    }
    if (targets.kind === 'done') {
        await answer(ctx, ALREADY_DONE_NOTICE);
        return;
    }

    const [decideError, outcome] = await to(decide(action, targets.proposals, userId));
    if (decideError) {
        // The transaction rolled back: every proposal is still pending
        console.error('[capability-menu] writing the owner\'s decision failed:', decideError);
        await answer(ctx, WRITE_FAILED_NOTICE);
        return;
    }
    if (outcome.kind === 'rejected') {
        if (outcome.rejected === 0) {
            await answer(ctx, ALREADY_DONE_NOTICE);
            return;
        }
        await answer(ctx, `已忽略 ${outcome.rejected} 条`);
        await rewriteMessage(ctx, outcomeTextOf(outcome));
        return;
    }

    const { applied, superseded, unchanged } = outcome.result;
    if (applied === 0 && superseded === 0 && unchanged === 0) {
        await answer(ctx, ALREADY_DONE_NOTICE);
        return;
    }
    const toast = applied > 0 ? `已应用 ${applied} 条` : superseded > 0 ? DRIFTED_NOTICE : UNCHANGED_NOTICE;
    await answer(ctx, toast);
    await rewriteMessage(ctx, outcomeTextOf(outcome));
};

/** Register the `catalog:` half of the callback_query data handlers */
export const registerCapabilityApprovalCallbacks = (bot: Bot): void => {
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
