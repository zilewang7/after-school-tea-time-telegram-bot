import type { FileFacts } from './file-facts.mts';
import { resolveImport } from './resolve-import.mts';

/** An import from one src/ file to another */
export interface ImportEdge {
    from: string;
    to: string;
    line: number;
    dynamic: boolean;
    typeOnly: boolean;
}

export const isSrcFile = (path: string): boolean => path.startsWith('src/');

/** Import edges between src/ files; imports of packages and of files outside src/ are dropped */
export const buildImportGraph = (factsByPath: ReadonlyMap<string, FileFacts>): ImportEdge[] => {
    const srcFiles = new Set([...factsByPath.keys()].filter(isSrcFile));
    const edges: ImportEdge[] = [];
    for (const from of srcFiles) {
        for (const reference of factsByPath.get(from)?.references ?? []) {
            const to = resolveImport(from, reference.specifier, srcFiles);
            if (to === undefined) continue;
            edges.push({ from, to, line: reference.line, dynamic: reference.dynamic, typeOnly: reference.typeOnly });
        }
    }
    return edges;
};
