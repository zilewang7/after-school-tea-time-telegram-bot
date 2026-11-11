/**
 * Layer order inside src/, lowest first. A file may import its own layer and
 * any lower one, never a higher one:
 *
 *   0  shared, types, config, util.ts, state.ts   small helpers and config readers
 *   1  db                                          models and queries
 *   2  services, telegram, ai, widget-image        talk to the outside world
 *   3  reply, cmd, panel                           features built on the above
 *   4  index.ts                                    the entry point
 *
 * The key is the first path segment below src/: a directory, or a file that
 * sits directly in src/.
 */
const LAYER_BY_ENTRY: ReadonlyMap<string, number> = new Map([
    ['shared', 0],
    ['types', 0],
    ['config', 0],
    ['util.ts', 0],
    ['state.ts', 0],
    ['db', 1],
    ['services', 2],
    ['telegram', 2],
    ['ai', 2],
    ['widget-image', 2],
    ['reply', 3],
    ['cmd', 3],
    ['panel', 3],
    ['index.ts', 4],
]);

/** Where this table lives, for messages that ask to extend it */
export const LAYER_TABLE_FILE = 'scripts/lib/check-deps/layers.mts';

/** `src/db/x.ts` → `db`, `src/util.ts` → `util.ts`; undefined outside src/ */
export const srcEntryOf = (path: string): string | undefined => {
    const segments = path.split('/');
    if (segments[0] !== 'src' || segments.length < 2) return undefined;
    return segments[1];
};

/** The layer of a src/ file; undefined when its entry is not in the table */
export const layerOf = (path: string): number | undefined => {
    const entry = srcEntryOf(path);
    return entry === undefined ? undefined : LAYER_BY_ENTRY.get(entry);
};
