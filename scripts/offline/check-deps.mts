/**
 * Offline cases for the dependency guard (scripts/check-deps.mts): the import
 * cycle, layering, index file and type assertion rules on small in-memory
 * sources, the baseline ratchet, and the per-file facts cache.
 *
 * Run: npx tsx scripts/offline/check-deps.mts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { analyzeSources } from '../lib/check-deps/analyze-sources.mts';
import { baselineOf, EMPTY_BASELINE, parseBaseline, serializeBaseline } from '../lib/check-deps/baseline.mts';
import { collectFacts } from '../lib/check-deps/collect-facts.mts';
import { hashText, readFactsCache, writeFactsCache } from '../lib/check-deps/facts-cache.mts';
import { factsOf } from '../lib/check-deps/file-facts.mts';
import { findNewViolations } from '../lib/check-deps/new-violations.mts';
import { resolveImport } from '../lib/check-deps/resolve-import.mts';
import { tightenBaseline } from '../lib/check-deps/tighten.mts';

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-check-deps-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));

const sourcesOf = (files: Record<string, string>): Map<string, string> => new Map(Object.entries(files));

const keysOf = (violations: readonly { key: string }[]): string[] => violations.map((violation) => violation.key);

/** A small tree that follows every rule: db below services below reply */
const CLEAN_TREE = {
    'src/shared/text.ts': `export const trim = (value: string): string => value.trim();\n`,
    'src/db/store.ts': `import { trim } from '../shared/text.js';\nexport const save = (value: string): string => trim(value);\n`,
    'src/services/sender.ts': `import { save } from '../db/store.js';\nexport const send = (value: string): string => save(value);\n`,
    'src/reply/answer.ts': `import { send } from '../services/sender.js';\nexport const answer = (): string => send(' hi ');\n`,
    'src/reply/index.ts': `export { answer } from './answer.js';\n`,
};

const results: CaseResult[] = [];

results.push(
    await runCase('a clean tree has no findings', () => {
        const findings = analyzeSources(sourcesOf(CLEAN_TREE));
        expect(findings.fileCount === 5, 'all five files are analyzed');
        expect(findings.cycleCount === 0 && findings.importCycles.length === 0, 'no import cycle');
        expect(findings.upwardImports.length === 0, 'no upward import');
        expect(findings.unlistedEntries.length === 0, 'every entry has a layer');
        expect(findings.indexFileCode.size === 0, 'the index file only re-exports');
        expect(findings.typeAssertions.size === 0, 'no type assertion');
        expect(findNewViolations(findings, EMPTY_BASELINE).length === 0, 'nothing new against an empty baseline');
    }),
);

results.push(
    await runCase('a static import cycle is reported edge by edge with the path back', () => {
        const findings = analyzeSources(
            sourcesOf({
                'src/services/a.ts': `import { b } from './b.js';\nexport const a = (): number => b();\n`,
                'src/services/b.ts': `\nimport { c } from './c.js';\nexport const b = (): number => c();\n`,
                'src/services/c.ts': `import { a } from './a.js';\nexport const c = (): number => a();\n`,
                'src/services/d.ts': `import { a } from './a.js';\nexport const d = a;\n`,
            }),
        );
        expect(findings.cycleCount === 1, 'one cycle');
        expect(
            keysOf(findings.importCycles).join('|') ===
                'src/services/a.ts -> src/services/b.ts|src/services/b.ts -> src/services/c.ts|src/services/c.ts -> src/services/a.ts',
            'the three edges of the cycle, sorted; the edge from d into the cycle is not one of them',
        );
        const fromB = findings.importCycles.find((violation) => violation.path === 'src/services/b.ts');
        expect(fromB?.line === 2, 'the edge points at the import line');
        expect(
            fromB?.message.includes('src/services/b.ts -> src/services/c.ts -> src/services/a.ts -> src/services/b.ts') === true,
            'the message spells out the whole cycle',
        );
        expect(fromB?.message.includes('import type') === true, 'the message says what to do instead');
    }),
);

results.push(
    await runCase('a file that imports itself is a cycle', () => {
        const findings = analyzeSources(sourcesOf({ 'src/services/self.ts': `import './self.js';\nexport const x = 1;\n` }));
        expect(findings.cycleCount === 1, 'one cycle');
        expect(keysOf(findings.importCycles).join('|') === 'src/services/self.ts -> src/services/self.ts', 'the self edge');
    }),
);

results.push(
    await runCase('type-only imports and import() never close a cycle', () => {
        const findings = analyzeSources(
            sourcesOf({
                'src/services/a.ts': `import { b } from './b.js';\nexport interface A { name: string }\nexport const a = b;\n`,
                'src/services/b.ts': `import type { A } from './a.js';\nexport const b = (value: A): string => value.name;\n`,
                'src/services/c.ts': `import { type A } from './a.js';\nexport const c = (value: A): string => value.name;\n`,
                'src/services/d.ts': `export { type A } from './a.js';\nexport type * from './c.js';\nimport { e } from './e.js';\nexport const d = e;\n`,
                'src/services/e.ts': `export const e = async (): Promise<unknown> => import('./d.js');\n`,
                'src/services/f.ts': `import { a } from './a.js';\nexport type Loaded = typeof import('./a.js');\nexport const f = a;\n`,
            }),
        );
        expect(findings.cycleCount === 0, 'no cycle: every way back is type-only or dynamic');
        expect(findings.importCycles.length === 0, 'no cycle edge');
    }),
);

results.push(
    await runCase('export from and a default import with type specifiers are runtime imports', () => {
        const findings = analyzeSources(
            sourcesOf({
                'src/services/a.ts': `export * from './b.js';\nexport const a = 1;\n`,
                'src/services/b.ts': `import a, { type Unused } from './c.js';\nexport const b = a;\nexport type { Unused };\n`,
                'src/services/c.ts': `export { a as default } from './a.js';\nexport type Unused = number;\n`,
            }),
        );
        expect(findings.cycleCount === 1, 'export * and the default import close the cycle');
        expect(findings.importCycles.length === 3, 'three edges');
    }),
);

results.push(
    await runCase('an upward import is reported with both layers; downward and same-layer imports are not', () => {
        const findings = analyzeSources(
            sourcesOf({
                ...CLEAN_TREE,
                'src/db/store.ts': `import { trim } from '../shared/text.js';\nimport { answer } from '../reply/answer.js';\nexport const save = (value: string): string => trim(value) + answer.name;\n`,
                'src/ai/model.ts': `import { send } from '../services/sender.js';\nexport const model = send;\n`,
                'src/index.ts': `import { answer } from './reply/index.js';\nanswer();\n`,
            }),
        );
        expect(keysOf(findings.upwardImports).join('|') === 'src/db/store.ts -> src/reply/answer.ts', 'only the db to reply edge');
        const upward = findings.upwardImports[0];
        expect(upward?.path === 'src/db/store.ts' && upward.line === 2, 'located at the import line');
        expect(
            upward?.message.startsWith('db (layer 1) imports reply (layer 3) via src/reply/answer.ts;') === true,
            'the message names both layers and the target',
        );
        expect(upward?.message.includes('move the code it needs down') === true, 'the message says what to do instead');
    }),
);

results.push(
    await runCase('an upward import() and an upward import type both count as upward', () => {
        const findings = analyzeSources(
            sourcesOf({
                ...CLEAN_TREE,
                'src/db/late.ts': `export const late = async (): Promise<unknown> => (await import('../reply/answer.js')).answer();\n`,
                'src/db/typed.ts': `import type { answer } from '../reply/answer.js';\nexport type Answer = typeof answer;\n`,
                'src/db/named.ts': `import { type answer } from '../reply/answer.js';\nexport type Named = typeof answer;\n`,
            }),
        );
        expect(
            keysOf(findings.upwardImports).join('|') ===
                'src/db/late.ts -> src/reply/answer.ts|src/db/named.ts -> src/reply/answer.ts|src/db/typed.ts -> src/reply/answer.ts',
            'the dynamic import and both type-only forms are reported',
        );
        const typed = findings.upwardImports.find((violation) => violation.path === 'src/db/typed.ts');
        expect(typed?.message.includes('imports a type from') === true, 'a type-only import is named as such');
        expect(typed?.message.includes('move the type down') === true, 'and the advice is about the type');
        expect(findings.cycleCount === 0, 'a dynamic import is no cycle');
    }),
);

results.push(
    await runCase('a src entry without a layer is reported and no baseline covers it', () => {
        const findings = analyzeSources(sourcesOf({ ...CLEAN_TREE, 'src/ingest/pipeline.ts': `export const run = 1;\n` }));
        expect(keysOf(findings.unlistedEntries).join('|') === 'src/ingest', 'the new directory');
        const accepted = baselineOf(findings);
        const newViolations = findNewViolations(findings, accepted);
        expect(newViolations.length === 1, 'still new after accepting everything');
        expect(
            newViolations[0]?.message.includes('scripts/lib/check-deps/layers.mts') === true,
            'the message points at the layer table',
        );
    }),
);

results.push(
    await runCase('index files may only re-export, except the two listed ones', () => {
        const findings = analyzeSources(
            sourcesOf({
                'src/services/index.ts': `import { a } from './a.js';\nexport { a };\nexport * from './b.js';\nexport type { B } from './b.js';\n;\n`,
                'src/services/a.ts': `export const a = 1;\n`,
                'src/services/b.ts': `export type B = number;\nexport const b = 2;\n`,
                'src/telegram/index.ts': `export { x } from './x.js';\n\nexport const helper = (): number => 1;\nexport interface Shape { size: number }\n`,
                'src/telegram/x.ts': `export const x = 1;\n`,
                'webapp/src/components/index.tsx': `export const Panel = (): null => null;\n`,
                'src/index.ts': `import { a } from './services/index.js';\nconsole.log(a);\n`,
                'src/db/index.ts': `export const dbReady = Promise.resolve();\n`,
            }),
        );
        expect([...findings.indexFileCode.keys()].sort().join('|') === 'src/telegram/index.ts|webapp/src/components/index.tsx', 'the two index files with code');
        expect(findings.indexFileCode.get('src/telegram/index.ts')?.join(',') === '3,4', 'one line per statement that is not a re-export');
        const newViolations = findNewViolations(findings, EMPTY_BASELINE);
        const telegram = newViolations.find((violation) => violation.path === 'src/telegram/index.ts');
        expect(telegram?.line === 3, 'reported at the first statement with code');
        expect(telegram?.message.includes('re-export it from here') === true, 'the message says what to do instead');
    }),
);

results.push(
    await runCase('type assertions: as and <T> count, as const, satisfies and renames do not', () => {
        const findings = analyzeSources(
            sourcesOf({
                'scripts/sample.mts': [
                    `import { readFileSync as read } from 'node:fs';`,
                    `export { read as readText };`,
                    `import * as path from 'node:path';`,
                    `const value: unknown = JSON.parse(read('x', 'utf8'));`,
                    `const name = value as string;`,
                    `const twice = value as unknown as number;`,
                    `const old = <string>value;`,
                    `const fixed = ['a', 'b'] as const;`,
                    `const checked = { a: 1 } satisfies Record<string, number>;`,
                    `const literal = <const>['c'];`,
                    `export const all = [name, twice, old, fixed, checked, literal, path.sep];`,
                ].join('\n'),
                'webapp/src/view.tsx': `export const View = (props: { id: unknown }): string => <>{String(props.id as number)}</>;\n`,
            }),
        );
        expect(findings.typeAssertions.get('scripts/sample.mts')?.join(',') === '5,6,6,7', 'as, both halves of as unknown as, and <T>');
        expect(findings.typeAssertions.get('webapp/src/view.tsx')?.join(',') === '1', 'an as inside JSX');
    }),
);

results.push(
    await runCase('relative imports resolve like the compiler; packages and missing files are ignored', () => {
        const known = new Set(['src/a.ts', 'src/view.tsx', 'src/lib/index.ts', 'src/data.json', 'scripts/tool.mts']);
        expect(resolveImport('src/b.ts', './a.js', known) === 'src/a.ts', '.js finds the .ts file');
        expect(resolveImport('src/b.ts', './view.js', known) === 'src/view.tsx', '.js finds the .tsx file');
        expect(resolveImport('src/b.ts', './lib', known) === 'src/lib/index.ts', 'a directory finds its index');
        expect(resolveImport('src/lib/c.ts', '../data.json', known) === 'src/data.json', 'a json file');
        expect(resolveImport('scripts/x.mts', './tool.mts', known) === 'scripts/tool.mts', 'an explicit .mts');
        expect(resolveImport('src/b.ts', 'grammy', known) === undefined, 'a package');
        expect(resolveImport('src/b.ts', './gone.js', known) === undefined, 'a missing file');
    }),
);

results.push(
    await runCase('against a baseline only new violations fail, each with path:line and advice', () => {
        // db -> reply is upward and closes the cycle db -> reply -> services -> db
        const store = [
            `import { trim } from '../shared/text.js';`,
            `import { answer } from '../reply/answer.js';`,
            `export const save = (value: unknown): string => trim(value as string) + answer.name;`,
        ];
        const before = analyzeSources(sourcesOf({ ...CLEAN_TREE, 'src/db/store.ts': store.join('\n') }));
        expect(before.cycleCount === 1 && before.upwardImports.length === 1, 'the starting state has one of each');
        const baseline = parseBaseline(serializeBaseline(baselineOf(before)));
        expect(findNewViolations(before, baseline).length === 0, 'the state the baseline was taken from passes');

        const after = analyzeSources(
            sourcesOf({
                ...CLEAN_TREE,
                'src/db/store.ts': [...store, `export const size = (value: unknown): number => value as number;`].join('\n'),
                'src/shared/text.ts': `import { send } from '../services/sender.js';\nexport const trim = (value: string): string => send(value).trim();\n`,
            }),
        );
        const newViolations = findNewViolations(after, baseline);
        const upward = newViolations.find((violation) => violation.message.startsWith('shared (layer 0) imports services (layer 2)'));
        expect(upward?.path === 'src/shared/text.ts' && upward.line === 1, 'the new upward import, at its line');
        const cycleEdges = newViolations.filter((violation) => violation.message.includes('static import cycle'));
        expect(
            cycleEdges.map((violation) => violation.path).join('|') === 'src/db/store.ts|src/shared/text.ts',
            'the two edges that pull shared into the cycle are new; the old cycle edges are not',
        );
        expect(cycleEdges[0]?.line === 1, 'the db edge points at the shared import');
        const assertion = newViolations.find((violation) => violation.message.startsWith('type assertions (`as`) grew from 1 to 2'));
        expect(assertion?.path === 'src/db/store.ts', 'the grown assertion count of the file');
        expect(assertion?.message.includes('(lines 3, 4)') === true, 'the lines to look at');
        expect(assertion?.message.includes('type guard') === true, 'the advice');
        expect(
            !newViolations.some((violation) => violation.message.startsWith('db (layer 1) imports reply')),
            'the upward import already in the baseline is not reported',
        );
    }),
);

results.push(
    await runCase('the ratchet drops what no longer occurs and lowers counts, but never adds', () => {
        const baseline = {
            importCycles: ['src/a.ts -> src/b.ts', 'src/b.ts -> src/a.ts'],
            upwardImports: ['src/db/store.ts -> src/reply/answer.ts', 'src/db/gone.ts -> src/reply/answer.ts'],
            indexFileCode: new Map([['src/telegram/index.ts', 2]]),
            typeAssertions: new Map([
                ['scripts/sample.mts', 3],
                ['scripts/fixed.mts', 1],
                ['scripts/same.mts', 2],
            ]),
        };
        const findings = analyzeSources(
            sourcesOf({
                ...CLEAN_TREE,
                'src/db/store.ts': `import { answer } from '../reply/answer.js';\nexport const save = answer;\n`,
                'src/db/new.ts': `import { answer } from '../reply/answer.js';\nexport const fresh = answer;\n`,
                'src/telegram/index.ts': `export const a = 1;\nexport const b = 2;\n`,
                'scripts/sample.mts': `export const a = (1 as number) + (2 as number);\n`,
                'scripts/same.mts': `export const a = (1 as number) + (2 as number) + (3 as number);\n`,
            }),
        );
        const tightening = tightenBaseline(baseline, findings);
        expect(tightening.baseline.importCycles.length === 0, 'the fixed cycle is gone');
        expect(tightening.baseline.upwardImports.join('|') === 'src/db/store.ts -> src/reply/answer.ts', 'the gone edge is dropped, the new one not added');
        expect(tightening.baseline.indexFileCode.get('src/telegram/index.ts') === 2, 'an unchanged count stays');
        expect(tightening.baseline.typeAssertions.get('scripts/sample.mts') === 2, 'a lower count is lowered');
        expect(!tightening.baseline.typeAssertions.has('scripts/fixed.mts'), 'a file at zero drops out');
        expect(tightening.baseline.typeAssertions.get('scripts/same.mts') === 2, 'a grown count is not raised');
        expect(
            tightening.changes.join(', ') ===
                '2 import cycle edge(s) gone, 1 upward import(s) gone, fewer type assertions in 2 file(s)',
            'the changes are summed up',
        );
        expect(tightenBaseline(tightening.baseline, findings).changes.length === 0, 'a second pass changes nothing');
    }),
);

results.push(
    await runCase('the baseline file is sorted, one entry per line, and reads back the same', () => {
        const baseline = {
            importCycles: ['src/b.ts -> src/a.ts', 'src/a.ts -> src/b.ts'],
            upwardImports: ['src/db/z.ts -> src/reply/a.ts', 'src/db/a.ts -> src/reply/a.ts'],
            indexFileCode: new Map([['src/x/index.ts', 1]]),
            typeAssertions: new Map([
                ['src/z.ts', 2],
                ['scripts/a.mts', 1],
                ['src/empty.ts', 0],
            ]),
        };
        const text = serializeBaseline(baseline);
        const lines = text.split('\n');
        expect(lines.includes('    "src/a.ts -> src/b.ts",') && lines.includes('    "src/b.ts -> src/a.ts"'), 'each edge on its own line');
        expect(text.indexOf('src/db/a.ts') < text.indexOf('src/db/z.ts'), 'edges sorted');
        expect(text.indexOf('"scripts/a.mts": 1') < text.indexOf('"src/z.ts": 2'), 'counts sorted by path');
        expect(!text.includes('src/empty.ts'), 'zero counts are left out');
        expect(text.endsWith('}\n'), 'ends with a newline');
        expect(serializeBaseline(parseBaseline(text)) === text, 'reads back to the same text');
    }),
);

results.push(
    await runCase('a malformed baseline is refused instead of read as empty', () => {
        const refused = (text: string): boolean => {
            try {
                parseBaseline(text);
                return false;
            } catch {
                return true;
            }
        };
        expect(refused('[]'), 'not an object');
        expect(refused('{"upwardImports": [1]}'), 'an edge that is not a string');
        expect(refused('{"typeAssertions": {"src/a.ts": -1}}'), 'a negative count');
        expect(parseBaseline('{}').upwardImports.length === 0, 'missing fields are empty');
    }),
);

results.push(
    await runCase('the facts cache reuses unchanged files and is dropped for another analyzer', async () => {
        const sources = sourcesOf(CLEAN_TREE);
        const cacheFile = join(scratch, 'cache', 'facts.json');
        const first = await collectFacts(sources, readFactsCache(cacheFile, 'analyzer-1'));
        expect(first.parsedCount === 5, 'an empty cache parses every file');
        writeFactsCache(cacheFile, 'analyzer-1', first.entries);

        const changed = new Map(sources);
        changed.set('src/db/store.ts', `export const save = (value: string): string => value as string;\n`);
        const second = await collectFacts(changed, readFactsCache(cacheFile, 'analyzer-1'));
        expect(second.parsedCount === 1, 'only the changed file is parsed again');
        expect(second.factsByPath.get('src/db/store.ts')?.typeAssertions.length === 1, 'with its new facts');
        expect(
            JSON.stringify(second.factsByPath.get('src/reply/answer.ts')) === JSON.stringify(factsOf('src/reply/answer.ts', CLEAN_TREE['src/reply/answer.ts'])),
            'a cached file has the facts a parse would give',
        );
        expect(second.entries.get('src/db/store.ts')?.hash === hashText(changed.get('src/db/store.ts') ?? ''), 'the new hash is kept');

        expect(readFactsCache(cacheFile, 'analyzer-2').size === 0, 'another analyzer key ignores the cache');
        writeFileSync(cacheFile, '{"analyzerKey": "analyzer-1", "files": ');
        expect(readFactsCache(cacheFile, 'analyzer-1').size === 0, 'a torn file is ignored');
        expect(readFactsCache(join(scratch, 'missing.json'), 'analyzer-1').size === 0, 'a missing file is ignored');
    }),
);

reportResults(results);
