import type { ImportEdge } from './import-graph.mts';
import { LAYER_TABLE_FILE, layerOf, srcEntryOf } from './layers.mts';
import { edgeKey, uniqueByKey, type KeyedViolation } from './violation.mts';

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
    const violations: KeyedViolation[] = [];
    for (const edge of edges) {
        const fromLayer = layerOf(edge.from);
        const toLayer = layerOf(edge.to);
        if (fromLayer === undefined || toLayer === undefined || fromLayer >= toLayer) continue;
        violations.push({ key: edgeKey(edge.from, edge.to), path: edge.from, line: edge.line, message: upwardMessage(edge) });
    }
    return uniqueByKey(violations);
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
