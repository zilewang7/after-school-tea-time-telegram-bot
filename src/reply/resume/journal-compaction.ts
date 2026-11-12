/**
 * The journal a kept checkpoint stores. A reply delivers one file and one
 * widget, and a later file or widget chunk replaces the earlier one on screen
 * and in the delivery (processChunk keeps the last). Replaying only the last
 * of each therefore shows the same thing, and the earlier copies (a file
 * written in parts repeats everything before each part) need not be kept.
 */
import type { StreamChunk } from '../../ai/types.js';
import type { ToolLoopCheckpoint } from '../../ai/tools/tool-loop-checkpoint.js';

/** Position of the last chunk of a type, or -1 */
const lastIndexOfType = (journal: readonly StreamChunk[], type: StreamChunk['type']): number => {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
        if (journal[index]?.type === type) return index;
    }
    return -1;
};

/** Every chunk in order, except the file and widget chunks that a later one replaces */
export const compactJournal = (journal: readonly StreamChunk[]): StreamChunk[] => {
    const lastFile = lastIndexOfType(journal, 'file');
    const lastWidget = lastIndexOfType(journal, 'widget');
    return journal.filter((chunk, index) => {
        if (chunk.type === 'file') return index === lastFile;
        if (chunk.type === 'widget') return index === lastWidget;
        return true;
    });
};

/** A copy of the checkpoint with the compacted journal; the loop's own value is untouched */
export const withCompactedJournal = (checkpoint: ToolLoopCheckpoint): ToolLoopCheckpoint => ({
    ...checkpoint,
    journal: compactJournal(checkpoint.journal),
});
