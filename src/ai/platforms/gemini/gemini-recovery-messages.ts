/**
 * What a recovering Gemini round shows and logs (design 2026-1112-1123 §5.3,
 * §5.5, §5.6). The status lines ride the existing `status` chunk: the line in
 * the message, typing, and the panel's status line.
 */
import type { StreamChunk } from '../../types.js';
import type {
    GiveUpReason,
    RecoverableKind,
    RoundFailureKind,
    RoundFailurePhase,
} from './gemini-recovery-policy.js';

const KIND_TEXT: Readonly<Record<RecoverableKind, string>> = {
    rate_limit: '被限流（429）',
    timeout: '超时',
    upstream: '服务端出错（5xx）',
    network: '连接中断',
};

const statusChunk = (text: string): StreamChunk => ({ type: 'status', status: { text, chatAction: 'typing' } });

/** While waiting: ⟳ 第 5 轮被限流（429），45 秒后第 3 次尝试 */
export const waitingStatus = (
    roundNumber: number,
    kind: RecoverableKind,
    waitMs: number,
    nextAttempt: number
): StreamChunk =>
    statusChunk(
        `⟳ 第 ${roundNumber} 轮${KIND_TEXT[kind]}，${Math.round(waitMs / 1000)} 秒后第 ${nextAttempt} 次尝试`
    );

/** Sent again, the stream not open yet: ⟳ 第 5 轮重试中（第 3 次尝试） */
export const retryingStatus = (roundNumber: number, attempt: number): StreamChunk =>
    statusChunk(`⟳ 第 ${roundNumber} 轮重试中（第 ${attempt} 次尝试）`);

/** The stream opened: the status line goes away */
export const clearedStatus = (): StreamChunk => ({ type: 'status' });

/**
 * Thinking already shown cannot be taken back (no chunk retracts, the live
 * thinking page only appends), so the retry's thinking follows a marker.
 */
export const retriedThinkingMarker = (roundNumber: number): StreamChunk => ({
    type: 'thinking',
    content: `\n\n〔第 ${roundNumber} 轮生成中断，已自动重试，以下为重新生成的思考〕\n\n`,
});

const describeError = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);

export interface FailedAttemptFacts {
    readonly roundNumber: number;
    readonly phase: RoundFailurePhase;
    readonly kind: RoundFailureKind;
    /** Which attempt of the round failed, from 1 */
    readonly attempt: number;
}

/** [gemini-recover] round=5 phase=open kind=rate_limit attempt=2 wait=45000ms */
export const formatRetryLine = (facts: FailedAttemptFacts, waitMs: number): string =>
    `[gemini-recover] round=${facts.roundNumber} phase=${facts.phase} kind=${facts.kind} attempt=${facts.attempt} wait=${waitMs}ms`;

/** [gemini-recover] round=5 gave up after 4 attempts: kind_limit (phase=open kind=rate_limit) <error> */
export const formatGiveUpLine = (facts: FailedAttemptFacts, reason: GiveUpReason, error: unknown): string =>
    `[gemini-recover] round=${facts.roundNumber} gave up after ${facts.attempt} attempts: ${reason} ` +
    `(phase=${facts.phase} kind=${facts.kind}) ${describeError(error)}`;

/** A stream that ended with neither an error nor a finish reason is kept as the round */
export const formatNoFinishLine = (roundNumber: number, attempt: number): string =>
    `[gemini-recover] round=${roundNumber} attempt=${attempt} ended without a finish reason or an error; kept as the round's result`;
