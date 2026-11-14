import type { Node, SourceFile } from '@typescript/typescript6';
import { ts } from './typescript.mts';

/**
 * Syntax tree only: no program and no type checker. JSDoc is skipped, no rule
 * reads it and the comments are a large share of the text.
 */
export const parseSource = (path: string, text: string): SourceFile =>
    ts.createSourceFile(
        path,
        text,
        { languageVersion: ts.ScriptTarget.ESNext, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
        false,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

/** 1-based line of a node */
export const lineOf = (sourceFile: SourceFile, node: Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
