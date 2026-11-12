/**
 * Why a reply's checkpoint is not there when "继续" is pressed (design
 * 2026-1112-1123 §6.3). Logged on the click, so the owner can tell how many
 * checkpoints restarts cost before deciding whether to store them (D3).
 */
import { match, P } from 'ts-pattern';

export type CheckpointMissingReason = 'restart' | 'expired' | 'evicted';

export interface CheckpointMissingInput {
    /** Epoch ms the failed version was created (its version record's createdAt) */
    readonly failedVersionCreatedAt: number;
    /** Epoch ms this process started; the registry lives in its memory */
    readonly processStartedAt: number;
    readonly now: number;
    /** How long a kept checkpoint lives */
    readonly ttlMs: number;
}

/**
 * A version older than the process lost its checkpoint to the restart; a
 * younger one older than the lifetime ran out; anything else was pushed out
 * by the registry's limits.
 */
export const checkpointMissingReason = (input: CheckpointMissingInput): CheckpointMissingReason =>
    match(input)
        .with(
            P.when(({ failedVersionCreatedAt, processStartedAt }) => failedVersionCreatedAt < processStartedAt),
            (): CheckpointMissingReason => 'restart'
        )
        .with(
            P.when(({ failedVersionCreatedAt, now, ttlMs }) => now - failedVersionCreatedAt > ttlMs),
            (): CheckpointMissingReason => 'expired'
        )
        .otherwise((): CheckpointMissingReason => 'evicted');
