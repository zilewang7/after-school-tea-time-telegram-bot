/**
 * The capability watcher's private-chat messages (thinking-effort design
 * 2026-1113-1742 §2.4/§6): one message per batch of pending capability
 * proposals, each item showing the changed fields old → new plus the source,
 * check date and confidence.
 *
 * Everything targets the owner's own chat, and every send is best-effort: a
 * blocked bot or a rate limit is logged and the proposals stay pending for the
 * next run or the owner's `/probe import`. Sends go through `runApiCall`, so
 * they share the per-chat pace with the streaming editor, and each is stored as
 * a bot row so later contexts see what the owner was asked.
 */
import { InlineKeyboard } from 'grammy';
import type { Api, Bot } from 'grammy';
import { concatMessages, type RenderedMessage } from 'telegram-md-entities';
import type { ModelCapabilitySource, ModelCatalogConfidence } from '../config/model-capabilities.js';
import { modelCatalogVersion } from '../config/model-catalog.js';
import { getOwnerUserId } from '../config/owner.js';
import { writeBotMessageRow } from '../db/bot-message-row.js';
import { toApiEntities } from '../telegram/api-entities.js';
import { runApiCall } from '../telegram/edit-coordinator.js';
import { boldText, plainText } from '../telegram/formatters/entity-text.js';
import {
    attachCapabilityProposalMessageIds,
    capabilityFieldChangesOf,
    capabilitySourceLabelOf,
    listPendingCapabilityProposals,
    type CapabilityProposalView,
} from './model-capability-service.js';

/** Telegram's practical limit for one approval message: four items fit safely */
const MAX_PROPOSALS_PER_MESSAGE = 4;

/** Button text has its own limit; long model ids are shortened */
const BUTTON_NAME_LIMIT = 24;

/** Callback data prefix the capability approval menu owns */
export const CAPABILITY_APPROVAL_PREFIX = 'catalog:';

/** Where a batch sits in the run's whole proposal list */
interface BatchPlacement {
    /** 0-based index of the batch's first proposal */
    readonly start: number;
    /** Proposals the run wants approved, all messages together */
    readonly total: number;
}

const confidenceLabelOf = (value: string | undefined): string =>
    value === 'high' ? '高' : value === 'low' ? '低' : '中';

/** Which provenance section the changed fields came from */
interface ProposalProvenance {
    readonly source: ModelCapabilitySource | undefined;
    readonly checkedOn: string | undefined;
    readonly confidence: ModelCatalogConfidence | undefined;
}

/**
 * A reasoning-only proposal carries the vendor's provenance inside
 * `reasoning` while the row-level source still names where the rest of the row
 * came from; a message claiming "代码 seed" for a models.dev drift would be
 * misleading, so the section that actually changed owns the line.
 */
const provenanceOf = (proposal: CapabilityProposalView): ProposalProvenance => {
    const changes = capabilityFieldChangesOf(proposal.payload, proposal.baseline);
    // A zero-change proposal only comes from a probe import (the watcher drafts
    // only when a value changed) and it can only carry vendor provenance in the
    // reasoning section, so that section owns the line in both cases.
    const reasoningOwnsProvenance =
        proposal.payload.reasoning !== undefined &&
        changes.every((change) => change.field.startsWith('reasoning.'));
    if (reasoningOwnsProvenance && proposal.payload.reasoning !== undefined) {
        return {
            source: proposal.payload.reasoning.source ?? proposal.payload.source,
            checkedOn: proposal.payload.reasoning.checkedOn ?? proposal.payload.checkedOn,
            confidence: proposal.payload.reasoning.confidence ?? proposal.payload.confidence,
        };
    }
    return {
        source: proposal.payload.source,
        checkedOn: proposal.payload.checkedOn,
        confidence: proposal.payload.confidence,
    };
};

/** The three provenance facts the message prints under the change list */
const provenanceTextOf = (proposal: CapabilityProposalView): string => {
    const provenance = provenanceOf(proposal);
    const source = capabilitySourceLabelOf(provenance.source);
    const date = provenance.checkedOn ?? '未知';
    const confidence = confidenceLabelOf(provenance.confidence);
    return `   来源 ${source}（${date}，置信 ${confidence}）`;
};

/** One numbered proposal: model, field-level old → new, provenance */
const renderProposal = (index: number, proposal: CapabilityProposalView): RenderedMessage => {
    const fragments: RenderedMessage[] = [boldText(`${index}. ${proposal.model}`), plainText('\n')];
    const changes = capabilityFieldChangesOf(proposal.payload, proposal.baseline);
    const shown = changes.slice(0, 6);
    for (const change of shown) {
        fragments.push(plainText(`   ${change.label}：${change.oldValue} → ${change.newValue}\n`));
    }
    if (changes.length > shown.length) {
        fragments.push(plainText(`   …还有 ${changes.length - shown.length} 项\n`));
    }
    if (changes.length === 0) fragments.push(plainText('   能力数据同步（字段值未变）\n'));
    fragments.push(plainText(provenanceTextOf(proposal)));
    return concatMessages(...fragments);
};

const headerTextOf = (placement: BatchPlacement, count: number): string => {
    const range =
        placement.total > MAX_PROPOSALS_PER_MESSAGE
            ? `第 ${placement.start + 1}–${placement.start + count} 条；`
            : '';
    return `🧩 能力巡检：${placement.total} 条待确认（${range}目录 ${modelCatalogVersion()}）`;
};

/** One message: header, its proposals, and a note when another message follows */
const renderBatch = (
    batch: readonly CapabilityProposalView[],
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

const applyButtonLabel = (proposal: CapabilityProposalView): string => {
    const name =
        proposal.model.length <= BUTTON_NAME_LIMIT
            ? proposal.model
            : `${proposal.model.slice(0, BUTTON_NAME_LIMIT - 1)}…`;
    return `✅ 应用 #${proposal.id} ${name}`;
};

/** The payload fingerprint a button carries: the proposal's detection time in ms */
const payloadFingerprintOf = (proposal: CapabilityProposalView): number => proposal.detectedAt.getTime();

/**
 * One fingerprint for the bulk buttons: the newest detection among every
 * pending proposal. A later detection means a payload was refreshed after this
 * message was rendered, so the bulk press must not act on it.
 */
const latestFingerprintOf = (proposals: readonly CapabilityProposalView[]): number =>
    proposals.reduce((latest, proposal) => Math.max(latest, payloadFingerprintOf(proposal)), 0);

/**
 * One row per proposal, then the all-or-nothing row. Every callback carries a
 * fingerprint of the payload it was rendered for: a stale message can thus not
 * approve a newer payload the owner never saw.
 */
const keyboardOf = (batch: readonly CapabilityProposalView[], latestFingerprint: number): InlineKeyboard => {
    const keyboard = new InlineKeyboard();
    for (const [index, proposal] of batch.entries()) {
        // The empty keyboard already holds one row; only later buttons start one
        if (index > 0) keyboard.row();
        keyboard.text(
            applyButtonLabel(proposal),
            `${CAPABILITY_APPROVAL_PREFIX}apply:${proposal.id}:${payloadFingerprintOf(proposal)}`
        );
    }
    keyboard
        .row()
        .text('✅ 全部应用', `${CAPABILITY_APPROVAL_PREFIX}all:apply:${latestFingerprint}`)
        .text('❌ 全部忽略', `${CAPABILITY_APPROVAL_PREFIX}all:reject:${latestFingerprint}`);
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
            console.error('[capability-notify] failed to store the notice row:', error);
        });
        return sent.message_id;
    } catch (error: unknown) {
        console.error(`[capability-notify] sending a notice to the owner (${ownerId}) failed:`, error);
        return null;
    }
};

const batchesOf = (
    proposals: readonly CapabilityProposalView[]
): readonly (readonly CapabilityProposalView[])[] => {
    const batches: CapabilityProposalView[][] = [];
    for (let index = 0; index < proposals.length; index += MAX_PROPOSALS_PER_MESSAGE) {
        batches.push(proposals.slice(index, index + MAX_PROPOSALS_PER_MESSAGE));
    }
    return batches;
};

/**
 * Ask the owner to approve the pending capability proposals, at most four per
 * message. The sends are best-effort: the returned list holds the messages that
 * went out, and the pending proposals are untouched.
 */
export const sendCapabilityProposalMessage = async (
    api: Api,
    proposals: readonly CapabilityProposalView[]
): Promise<readonly number[]> => {
    if (proposals.length === 0) return [];
    const ownerId = getOwnerUserId();
    if (ownerId === null) return [];
    const messageIds: number[] = [];
    const latestFingerprint = latestFingerprintOf(proposals);
    let start = 0;
    for (const batch of batchesOf(proposals)) {
        try {
            const message = renderBatch(batch, { start, total: proposals.length });
            const sent = await sendOwnerMessage(api, ownerId, message, keyboardOf(batch, latestFingerprint));
            if (sent === null) {
                console.error(
                    `[capability-notify] no approval message for proposals ${batch.map((item) => item.id).join(',')}`
                );
            } else {
                messageIds.push(sent);
                try {
                    await attachCapabilityProposalMessageIds(
                        batch.map((item) => item.id),
                        sent
                    );
                } catch (error: unknown) {
                    // The buttons still work; only the edit/resend pointer is lost
                    console.error('[capability-notify] failed to record the approval message id:', error);
                }
            }
        } catch (error: unknown) {
            console.error('[capability-notify] building the approval message failed:', error);
        }
        start += batch.length;
    }
    if (messageIds.length > 0) {
        console.log(
            `[capability-notify] asked the owner about ${proposals.length} proposals in ${messageIds.length} message(s)`
        );
    }
    return messageIds;
};

/**
 * Send the owner every pending capability proposal and return the number of
 * messages sent (0 = nothing pending, no owner, or every send failed and was
 * logged). `/probe import` calls this right after it queued its proposals.
 */
export const notifyPendingCapabilityProposals = async (bot: Bot): Promise<number> => {
    const pending = await listPendingCapabilityProposals();
    if (pending.length === 0) return 0;
    const messageIds = await sendCapabilityProposalMessage(bot.api, pending);
    return messageIds.length;
};
