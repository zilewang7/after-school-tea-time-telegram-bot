/**
 * Dependency guard: fails only on violations that are not in the baseline.
 *
 *   pnpm check-deps             check; exit 1 on anything new. Changes no file.
 *   pnpm check-deps --tighten   drop baseline entries that are fixed
 *   pnpm check-deps --accept    record the current state as the baseline
 *
 * Rules (static analysis with the TypeScript parser; nothing from src/ is
 * imported or run):
 * 1. No static import cycle between files in src/ (`import type` and
 *    `import()` do not count).
 * 2. A lower layer of src/ does not import a higher one, types included; the
 *    layer table is in scripts/lib/check-deps/layers.mts.
 * 3. index.ts / index.tsx files only re-export (exceptions with reasons in
 *    scripts/lib/check-deps/index-files.mts).
 * 4. The number of type assertions (`as`, `as const` excepted) per file in
 *    src/, webapp/src/ and scripts/ does not grow.
 *
 * The baseline (scripts/check-deps.baseline.json) lists what existed before.
 * A check never writes it: several sessions edit this checkout, and a baseline
 * rewritten from someone's half-done change would later fail the committed
 * code. After fixing an entry, run `--tighten` and commit the baseline with
 * the fix; it only removes entries and lowers counts, and does nothing while
 * there are new violations.
 *
 * `--accept` widens the baseline to whatever is there now, new violations
 * included. Use it only with the owner's approval (a file move that carries
 * existing entries to a new path is the usual reason).
 *
 * Parsed facts are cached per file in node_modules/.cache/check-deps, keyed
 * by the file's hash; a run where nothing changed does not load TypeScript.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFacts } from './lib/check-deps/analyze.mts';
import { baselineOf, EMPTY_BASELINE, parseBaseline, serializeBaseline, type Baseline } from './lib/check-deps/baseline.mts';
import { analyzerKeyOf, collectFacts } from './lib/check-deps/collect-facts.mts';
import { readFactsCache, writeFactsCache } from './lib/check-deps/facts-cache.mts';
import { findNewViolations } from './lib/check-deps/new-violations.mts';
import { formatFailureFooter, formatSummary, formatViolation } from './lib/check-deps/report.mts';
import { readSourceFiles } from './lib/check-deps/source-files.mts';
import { tightenBaseline } from './lib/check-deps/tighten.mts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASELINE_PATH = 'scripts/check-deps.baseline.json';
const CACHE_FILE = join(REPOSITORY_ROOT, 'node_modules', '.cache', 'check-deps', 'facts.json');
const CHECKED_DIRECTORIES = ['src', 'webapp/src', 'scripts'] as const;

const readBaseline = (): Baseline => {
    const path = join(REPOSITORY_ROOT, BASELINE_PATH);
    return existsSync(path) ? parseBaseline(readFileSync(path, 'utf8')) : EMPTY_BASELINE;
};

const writeBaseline = (baseline: Baseline): void => {
    writeFileSync(join(REPOSITORY_ROOT, BASELINE_PATH), serializeBaseline(baseline));
};

const startedAt = performance.now();
const sources = readSourceFiles(REPOSITORY_ROOT, CHECKED_DIRECTORIES);
const analyzerKey = analyzerKeyOf(sources);
const collected = await collectFacts(sources, readFactsCache(CACHE_FILE, analyzerKey));
if (collected.parsedCount > 0) {
    try {
        writeFactsCache(CACHE_FILE, analyzerKey, collected.entries);
    } catch (error) {
        // Only the next run's speed depends on it
        console.log(`(facts cache not written: ${error instanceof Error ? error.message : String(error)})`);
    }
}
const findings = analyzeFacts(collected.factsByPath);
const seconds = (performance.now() - startedAt) / 1000;
const summary = formatSummary(findings, seconds, collected.parsedCount);

if (process.argv.includes('--accept')) {
    writeBaseline(baselineOf(findings));
    for (const line of summary) console.log(line);
    console.log(`Recorded the current state in ${BASELINE_PATH}. This widens the guard: it needs the owner's approval.`);
    process.exit(0);
}

const baseline = readBaseline();
const newViolations = findNewViolations(findings, baseline);
const tightening = tightenBaseline(baseline, findings);
const tightenRequested = process.argv.includes('--tighten');

if (newViolations.length > 0) {
    for (const violation of newViolations) console.error(formatViolation(violation));
    for (const line of formatFailureFooter(newViolations.length, BASELINE_PATH)) console.error(line);
    if (tightenRequested) console.error('Nothing tightened: fix the new violations first.');
    process.exit(1);
}

for (const line of summary) console.log(line);
if (tightening.changes.length === 0) {
    if (tightenRequested) console.log('Nothing to tighten: the baseline matches the code.');
} else if (tightenRequested) {
    writeBaseline(tightening.baseline);
    console.log(`Baseline tightened (${tightening.changes.join(', ')}): commit ${BASELINE_PATH} with the fix.`);
} else {
    console.log(
        `The baseline is wider than the code (${tightening.changes.join(', ')}). ` +
            'If your change fixed these, run `pnpm check-deps --tighten` and commit the baseline with it.'
    );
}
