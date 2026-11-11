import type { ImportEdge } from './import-graph.mts';
import { LAYER_TABLE_FILE, layerOf, srcEntryOf } from './layers.mts';
import { compareText, edgeKey, uniqueByKey, type KeyedViolation } from './violation.mts';

/**
 * Ends the baseline key of an upward import that only carries types. With its
 * own key, turning the type import into a value import is a new violation, not
 * one the baseline already allows.
 */
const TYPE_ONLY_SUFFIX = ' (type)';

const describe = (path: string): string => `${srcEntryOf(path) ?? path} (layer ${layerOf(path) ?? '?'})`;

const upwardMessage = (edge: ImportEdge): string =>
    `${describe(edge.from)} imports ${edge.typeOnly ? 'a type from ' : ''}${describe(edge.to)} via ${edge.to}; ` +
    (edge.typeOnly
        ? 'move the type down to a layer at or below the importer'
        : 'move the code it needs down to a layer at or below the importer, or move the importer up');

/**
 * Imports from a lower layer into a higher one. `import()` counts too: it is
 * still a dependency on the higher layer, only a later one. So does a
 * type-only import: the lower layer is then written in terms of the higher one.
 */
export const findUpwardImports = (edges: readonly ImportEdge[]): KeyedViolation[] => {
    // One violation per pair of files
    const upwardEdges = new Map<string, ImportEdge>();
    for (const edge of edges) {
        const fromLayer = layerOf(edge.from);
        const toLayer = layerOf(edge.to);
        if (fromLayer === undefined || toLayer === undefined || fromLayer >= toLayer) continue;
        const pair = edgeKey(edge.from, edge.to);
        const known = upwardEdges.get(pair);
        // A value import of the same file outweighs a type import: it is the one to report
        if (known === undefined || (known.typeOnly && !edge.typeOnly)) upwardEdges.set(pair, edge);
    }
    return [...upwardEdges]
        .map(([pair, edge]) => ({
            key: edge.typeOnly ? `${pair}${TYPE_ONLY_SUFFIX}` : pair,
            path: edge.from,
            line: edge.line,
            message: upwardMessage(edge),
        }))
        .sort((left, right) => compareText(left.key, right.key));
};

/**
 * src/ entries missing from the layer table. Never recorded in the baseline:
 * the fix is one line in the table.
 */
export const findUnlistedEntries = (paths: Iterable<string>): KeyedViolation[] => {
    const violations: KeyedViolation[] = [];
    for (const path of paths) {
        const entry = srcEntryOf(path);
        if (entry === undefined || layerOf(path) !== undefined) continue;
        violations.push({
            key: `src/${entry}`,
            path,
            line: 1,
            message: `src/${entry} has no layer; add it to the table in ${LAYER_TABLE_FILE}`,
        });
    }
    return uniqueByKey(violations);
};
