/**
 * Where an interrupted tool loop can pick up again (design 2026-1112-1123 §6.2).
 *
 * A checkpoint is a ready-to-send next round plus everything the loop had
 * counted and shown up to that point. The loop hands a new one to
 * `PlatformConfig.checkpointSink` each time it reaches such a point; the caller
 * keeps the last one and may pass it back as `PlatformConfig.resumeFrom`.
 *
 * It is a value: nothing the loop does afterwards changes a checkpoint it has
 * handed out. The data inside (parts, buffers, strings) is shared by reference
 * with the running loop, never copied, and must not be mutated by anyone.
 */
import type { AgentToolUsage, PlatformType, StreamChunk } from '../types.js';

export interface ToolLoopCheckpoint {
    /** The platform that made it; only that platform can resume it */
    readonly platform: PlatformType;
    /** Rounds kept, at least 1; the round a resume opens is this plus one */
    readonly completedRounds: number;
    /** Tool usage of the kept rounds, as agentStats.toolUsage would show it */
    readonly toolUsage: readonly AgentToolUsage[];
    /**
     * Every chunk the kept rounds produced, in order, at the granularity they
     * were yielded: thinking, text, images, stickers, files, widgets and tool
     * records. No status chunks, no done chunk. A resume replays it first.
     */
    readonly journal: readonly StreamChunk[];
    /** The platform's own loop state; opaque to every caller */
    readonly state: unknown;
}

export type ToolLoopCheckpointSink = (checkpoint: ToolLoopCheckpoint) => void;
