import { findIndexFileCode } from './index-files.mts';
import { moduleReferencesOf, type ModuleReference } from './module-references.mts';
import { parseSource } from './parse-source.mts';
import { findTypeAssertions } from './type-assertions.mts';

/**
 * What the rules need from one file. It depends only on the path and the
 * text, so it can be cached and the parser skipped for unchanged files.
 */
export interface FileFacts {
    references: ModuleReference[];
    /** Lines of statements that are not re-exports, for index files that may not hold code */
    indexFileCode: number[];
    typeAssertions: number[];
}

export const factsOf = (path: string, text: string): FileFacts => {
    const sourceFile = parseSource(path, text);
    return {
        references: moduleReferencesOf(sourceFile),
        indexFileCode: findIndexFileCode(path, sourceFile),
        typeAssertions: findTypeAssertions(sourceFile),
    };
};
