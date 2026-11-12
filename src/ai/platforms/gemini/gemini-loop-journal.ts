/**
 * The display journal of a Gemini tool loop (design 2026-1112-1123 §6.2):
 * every chunk the loop yields except status lines, in order and at the
 * granularity it was yielded. One wrapper records it, so no branch of the
 * loop can forget to; a checkpoint copies what it holds at that moment, and a
 * resume replays a checkpoint's journal before the loop goes on.
 */
import type { StreamChunk } from '../../types.js';

/** Replayed chunks between two turns of the event loop */
export const REPLAY_BATCH_SIZE = 64;

/**
 * Yields what `loop` yields, each chunk recorded into `journal` before it is
 * handed on: by the time the loop runs again, every chunk it gave out is in
 * the journal, even the one a consumer stopped reading at.
 */
export async function* journaled(
    loop: AsyncGenerator<StreamChunk, void, undefined>,
    journal: StreamChunk[]
): AsyncGenerator<StreamChunk, void, undefined> {
    for await (const chunk of loop) {
        if (chunk.type !== 'status') journal.push(chunk);
        yield chunk;
    }
}

/** A macrotask: a microtask would not let timers and I/O run */
const nextEventLoopTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A checkpoint's journal again, each chunk a copy marked `replay`. A long
 * reply has thousands of chunks, so the event loop gets a turn between
 * batches instead of waiting for the whole replay.
 */
export async function* replayJournal(
    journal: readonly StreamChunk[]
): AsyncGenerator<StreamChunk, void, undefined> {
    for (const [index, chunk] of journal.entries()) {
        if (index > 0 && index % REPLAY_BATCH_SIZE === 0) await nextEventLoopTurn();
        yield { ...chunk, replay: true };
    }
}
