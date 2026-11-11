import type { AsExpression, Node, SourceFile, TypeAssertion, TypeNode } from 'typescript';
import { ts } from './typescript.mts';
import { lineOf } from './parse-source.mts';

/** `as const` / `<const>` only narrow a literal; they are not casts */
const isConstType = (type: TypeNode): boolean =>
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === 'const' &&
    type.typeArguments === undefined;

/**
 * `x as T` and the older `<T>x`: both cast. The second form is counted too,
 * so rewriting one into the other does not dodge the count. `satisfies` and
 * the `as` of an import or export rename are other syntax and never match.
 */
const isTypeAssertion = (node: Node): node is AsExpression | TypeAssertion =>
    (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !isConstType(node.type);

const collect = (sourceFile: SourceFile, node: Node, lines: number[]): void => {
    // The line of the target type: an expression cast across several lines starts above it
    if (isTypeAssertion(node)) lines.push(lineOf(sourceFile, node.type));
    ts.forEachChild(node, (child) => collect(sourceFile, child, lines));
};

/** Lines of every type assertion in a file, one entry per assertion */
export const findTypeAssertions = (sourceFile: SourceFile): number[] => {
    const lines: number[] = [];
    collect(sourceFile, sourceFile, lines);
    return lines;
};
