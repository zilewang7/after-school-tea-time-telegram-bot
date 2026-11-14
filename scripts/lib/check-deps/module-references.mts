import type { ExportDeclaration, ImportDeclaration, Node, SourceFile, Statement } from '@typescript/typescript6';
import { ts } from './typescript.mts';
import { lineOf } from './parse-source.mts';

/** One `import … from`, `export … from`, `import()` or `import('…')` type of a module */
export interface ModuleReference {
    specifier: string;
    line: number;
    /** `import()`: a runtime dependency, but loaded late, so it cannot form a load cycle */
    dynamic: boolean;
    /** Only types cross (`import type`, `export type … from`, `import('…').T`): nothing is loaded at runtime */
    typeOnly: boolean;
}

/** `import type …`, or `import { type A, type B }` where every name is a type */
const isTypeOnlyImport = (declaration: ImportDeclaration): boolean => {
    const clause = declaration.importClause;
    if (clause === undefined) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name !== undefined) return false;
    const bindings = clause.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
    return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
};

/** `export type … from`, or `export { type A } from` where every name is a type */
const isTypeOnlyExport = (declaration: ExportDeclaration): boolean => {
    if (declaration.isTypeOnly) return true;
    const clause = declaration.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return false;
    return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
};

const staticReference = (sourceFile: SourceFile, statement: Statement): ModuleReference | undefined => {
    const line = lineOf(sourceFile, statement);
    if (ts.isImportDeclaration(statement)) {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) return undefined;
        const typeOnly = isTypeOnlyImport(statement);
        return { specifier: statement.moduleSpecifier.text, line, dynamic: false, typeOnly };
    }
    if (ts.isExportDeclaration(statement)) {
        const moduleSpecifier = statement.moduleSpecifier;
        if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) return undefined;
        return { specifier: moduleSpecifier.text, line, dynamic: false, typeOnly: isTypeOnlyExport(statement) };
    }
    return undefined;
};

/** `import('./x.js')` with a literal path; a computed path cannot be followed */
const dynamicSpecifier = (node: Node): string | undefined => {
    if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
    const argument = node.arguments[0];
    if (argument === undefined || !ts.isStringLiteralLike(argument)) return undefined;
    return argument.text;
};

/** `import('./x.js').T` or `typeof import('./x.js')` in a type position */
const inlineTypeSpecifier = (node: Node): string | undefined => {
    if (!ts.isImportTypeNode(node) || !ts.isLiteralTypeNode(node.argument)) return undefined;
    const literal = node.argument.literal;
    return ts.isStringLiteralLike(literal) ? literal.text : undefined;
};

/** Cheap text test before the tree walk; a match in a comment only costs the walk */
const MAY_HAVE_IMPORT_CALL = /\bimport\s*\(/;

/** The references that are not statements: `import()` calls and `import('…')` types anywhere in the file */
const collectNestedReferences = (sourceFile: SourceFile, node: Node, references: ModuleReference[]): void => {
    const loaded = dynamicSpecifier(node);
    if (loaded !== undefined) {
        references.push({ specifier: loaded, line: lineOf(sourceFile, node), dynamic: true, typeOnly: false });
    }
    const typed = inlineTypeSpecifier(node);
    if (typed !== undefined) {
        references.push({ specifier: typed, line: lineOf(sourceFile, node), dynamic: false, typeOnly: true });
    }
    ts.forEachChild(node, (child) => collectNestedReferences(sourceFile, child, references));
};

/**
 * Every `import`, `export … from`, `import()` and `import('…')` type of another
 * module. Type-only ones are marked: they vanish from the emitted code, so they
 * cannot form a load cycle, but they are still a dependency on the other
 * module's layer. `import('x').T` and `typeof import('x')` are type-only: the
 * same dependency as an `import type`, written in place.
 */
export const moduleReferencesOf = (sourceFile: SourceFile): ModuleReference[] => {
    const references: ModuleReference[] = [];
    for (const statement of sourceFile.statements) {
        const reference = staticReference(sourceFile, statement);
        if (reference !== undefined) references.push(reference);
    }
    // Most files have no import( at all; skipping their walk saves a tenth of a cold run
    if (MAY_HAVE_IMPORT_CALL.test(sourceFile.text)) collectNestedReferences(sourceFile, sourceFile, references);
    return references;
};
