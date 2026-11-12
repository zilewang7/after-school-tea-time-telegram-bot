/**
 * What a "继续" click does once the button handler has claimed the reply
 * (design 2026-1112-1123 §6.4): check, then either say why not or hand back
 * the start of the resume. The button handler answers the click, calls
 * `start` and holds the claim until the resumed reply has ended.
 */
import type { Context } from 'grammy';
import { match } from 'ts-pattern';
import type { ContinueStartOutcome, ContinueVerdict } from '../../cmd/menus/response-menu.js';
import type { BotResponse } from '../../db/index.js';
import { clearReplyResumable } from '../../state.js';
import { checkpointRegistry, type CheckpointRegistry } from './checkpoint-registry.js';
import { CHECKPOINT_GONE_NOTICE, checkContinue, type ResumePlan } from './continue-checks.js';
import { resumeReply } from './resume-reply.js';

/** Epoch ms the latest version was stored; the version a missing checkpoint belonged to */
const latestVersionCreatedAt = (response: BotResponse): number => {
    const createdAt = response.getVersions().at(-1)?.createdAt;
    return createdAt === undefined ? Date.now() : Date.parse(createdAt);
};

/** Forget whatever is left of a checkpoint that can never be continued */
const dropGone = (
    registry: CheckpointRegistry,
    response: BotResponse,
    cause: 'missing' | 'superseded'
): void => {
    const { chatId, messageId: firstMessageId } = response;
    match(cause)
        .with('missing', () => {
            // Why it is gone, for the decision whether to store checkpoints (D3)
            const reason = registry.missingReason(latestVersionCreatedAt(response));
            console.log(`[resume] checkpoint missing reason=${reason} chat=${chatId} first=${firstMessageId}`);
        })
        .with('superseded', () => {
            console.log(`[resume] checkpoint dropped: a newer version exists chat=${chatId} first=${firstMessageId}`);
        })
        .exhaustive();
    registry.drop(chatId, firstMessageId);
    clearReplyResumable(chatId, firstMessageId);
};

/** Take the checkpoint (before the first wait) and run the resume */
const startResume = async (
    ctx: Context,
    response: BotResponse,
    plan: ResumePlan,
    registry: CheckpointRegistry
): Promise<ContinueStartOutcome> => {
    const entry = registry.take(response.chatId, response.messageId);
    if (entry === undefined) {
        // Only an expiry between the checks and the take gets here: it is gone
        // as if the checks had found it so
        dropGone(registry, response, 'missing');
        return 'gone';
    }
    await resumeReply(ctx, entry, plan, registry);
    return 'resumed';
};

/** The continue handler the button handler is given (wired in loader.ts) */
export const handleContinueClick = async (
    ctx: Context,
    response: BotResponse,
    registry: CheckpointRegistry = checkpointRegistry
): Promise<ContinueVerdict> => {
    const check = await checkContinue(ctx, response, registry);
    return match(check)
        .returnType<ContinueVerdict>()
        .with({ kind: 'gone' }, ({ cause }) => {
            dropGone(registry, response, cause);
            return { kind: 'gone', notice: CHECKPOINT_GONE_NOTICE };
        })
        .with({ kind: 'keep' }, ({ notice }) => ({ kind: 'keep', notice }))
        .with({ kind: 'ready' }, ({ plan }) => ({
            kind: 'ready',
            start: () => startResume(ctx, response, plan, registry),
        }))
        .exhaustive();
};
