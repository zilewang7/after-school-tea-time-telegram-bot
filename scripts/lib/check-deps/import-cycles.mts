import type { ImportEdge } from './import-graph.mts';
import { componentOf } from './strongly-connected.mts';
import { edgeKey, uniqueByKey, type KeyedViolation } from './violation.mts';

export interface ImportCycles {
    /** Groups of files that import each other, directly or through others */
    cycleCount: number;
    /** Every static edge inside such a group: removing enough of them breaks the cycle */
    violations: KeyedViolation[];
}

const successorsOf = (edges: readonly ImportEdge[]): Map<string, string[]> => {
    const successors = new Map<string, string[]>();
    for (const edge of edges) {
        const targets = successors.get(edge.from) ?? [];
        targets.push(edge.to);
        successors.set(edge.from, targets);
    }
    return successors;
};

/** Shortest import path from `start` to `goal`, both ends included */
const shortestPath = (successors: ReadonlyMap<string, readonly string[]>, start: string, goal: string): string[] => {
    const previous = new Map<string, string>();
    const queue = [start];
    const seen = new Set([start]);
    for (let index = 0; index < queue.length; index += 1) {
        const node = queue[index];
        if (node === undefined || node === goal) break;
        for (const successor of successors.get(node) ?? []) {
            if (seen.has(successor)) continue;
            seen.add(successor);
            previous.set(successor, node);
            queue.push(successor);
        }
    }
    const path = [goal];
    for (let node = previous.get(goal); node !== undefined; node = previous.get(node)) path.unshift(node);
    return path;
};

const cycleMessage = (edge: ImportEdge, cycle: readonly string[]): string =>
    `imports ${edge.to}, which closes the static import cycle ${[edge.from, ...cycle].join(' -> ')}; ` +
    'move what both sides need into a lower module, or use `import type` when only types cross';

/**
 * Static import cycles between files. `import()` is ignored: it loads after
 * the importing module has finished, so it cannot leave a binding uninitialised.
 * A type-only import is ignored too: it loads nothing.
 */
export const findImportCycles = (edges: readonly ImportEdge[]): ImportCycles => {
    const staticEdges = edges.filter((edge) => !edge.dynamic && !edge.typeOnly);
    const successors = successorsOf(staticEdges);
    const component = componentOf(successors);
    const cyclicEdges = staticEdges.filter(
        (edge) => edge.from === edge.to || component.get(edge.from) === component.get(edge.to),
    );
    // Within one component every node reaches every other, so the path back always exists
    const violations = cyclicEdges.map((edge) => ({
        key: edgeKey(edge.from, edge.to),
        path: edge.from,
        line: edge.line,
        message: cycleMessage(edge, edge.from === edge.to ? [edge.to] : shortestPath(successors, edge.to, edge.from)),
    }));
    const cyclicComponents = new Set(cyclicEdges.map((edge) => component.get(edge.from)));
    return { cycleCount: cyclicComponents.size, violations: uniqueByKey(violations) };
};
