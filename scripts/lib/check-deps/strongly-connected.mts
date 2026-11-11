/**
 * Tarjan's algorithm: the strongly connected components of a directed graph,
 * as a map from node to component number. Two nodes share a number exactly
 * when each reaches the other.
 */
export const componentOf = (successors: ReadonlyMap<string, readonly string[]>): Map<string, number> => {
    const visitIndex = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const component = new Map<string, number>();
    let nextVisitIndex = 0;
    let nextComponent = 0;

    const visit = (node: string): void => {
        visitIndex.set(node, nextVisitIndex);
        lowLink.set(node, nextVisitIndex);
        nextVisitIndex += 1;
        stack.push(node);
        onStack.add(node);
        for (const successor of successors.get(node) ?? []) {
            if (!visitIndex.has(successor)) {
                visit(successor);
                lowLink.set(node, Math.min(lowLink.get(node) ?? 0, lowLink.get(successor) ?? 0));
            } else if (onStack.has(successor)) {
                lowLink.set(node, Math.min(lowLink.get(node) ?? 0, visitIndex.get(successor) ?? 0));
            }
        }
        if (lowLink.get(node) !== visitIndex.get(node)) return;
        let member: string | undefined;
        do {
            member = stack.pop();
            if (member === undefined) break;
            onStack.delete(member);
            component.set(member, nextComponent);
        } while (member !== node);
        nextComponent += 1;
    };

    for (const node of successors.keys()) {
        if (!visitIndex.has(node)) visit(node);
    }
    return component;
};
