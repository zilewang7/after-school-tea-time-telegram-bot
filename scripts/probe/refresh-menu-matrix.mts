/**
 * Regenerate `scripts/probe/menu-matrix.mts` from the runtime catalog config.
 *
 * The probe CLI must not import `src/`: AGENTS requires a script that imports
 * src to import the offline harness first, and the harness rewrites `DB_PATH`,
 * which would break the probe's `TEST_INSTANCE` / `database.test.sqlite` gate.
 * The matrix therefore ships as a snapshot, and this dev tool is the only file
 * under `scripts/probe/` that reads the runtime config.
 *
 * Run after a menu (`src/config/models.ts`) or capability seed change:
 *
 *     npx tsx scripts/probe/refresh-menu-matrix.mts
 *
 * `scripts/offline/probe-matrix-sync.mts` fails until the snapshot is refreshed,
 * so a menu change cannot silently ship a stale probe matrix. This tool imports
 * the harness first, as the rule requires; it never opens the database.
 */
import '../offline/harness.mts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilitySeedOf } from '../../src/config/model-capability-seed.js';
import { platformOfModelId } from '../../src/config/model-catalog.js';
import { modelConfigs } from '../../src/config/models.js';
import { isProbePlatform, type EffortValue } from './effort-types.mts';
import type { MenuMatrixEntry } from './menu-matrix.mts';

/** The generated snapshot file this tool writes */
export const MENU_MATRIX_SOURCE_PATH = fileURLToPath(new URL('./menu-matrix.mts', import.meta.url));

/** Fallback if the seed is missing a checkedOn date (it covers all menu ids today) */
const FALLBACK_GENERATED_ON = '2026-11-13';

/**
 * The snapshot content from the runtime menu: ids and order from `modelConfigs`,
 * platform from the runtime router, reasoning facts from the capability seed.
 * A menu model must be a chat model; image catalog ids are not menu entries.
 */
export const menuMatrixEntriesFromRuntime = (): readonly MenuMatrixEntry[] =>
    modelConfigs.map((config) => {
        const capabilities = capabilitySeedOf(config.id);
        if (capabilities?.kind === 'image') {
            throw new Error(`refresh-menu-matrix: ${config.id} is an image model; the probe covers chat models only`);
        }
        const reasoning = capabilities?.reasoning;
        const platform = platformOfModelId(config.id);
        if (!isProbePlatform(platform)) {
            throw new Error(`refresh-menu-matrix: ${config.id} has no probe platform (${platform})`);
        }
        return {
            model: config.id,
            platform,
            vendorEfforts: reasoning?.efforts ?? [],
            vendorDefaultEffort: reasoning?.defaultEffort ?? null,
            vendorToggle: reasoning?.toggle === true,
            vendorDefaultEnabled: reasoning?.defaultEnabled ?? null,
        };
    });

/** The seed's check date, shown in the generated header (deterministic across reruns) */
const generatedOnOf = (): string =>
    capabilitySeedOf(modelConfigs[0]?.id ?? '')?.checkedOn ?? FALLBACK_GENERATED_ON;

const quote = (value: string): string => `'${value}'`;

const effortListOf = (efforts: readonly EffortValue[]): string => `[${efforts.map(quote).join(', ')}]`;

const effortValueOf = (effort: EffortValue | null): string => (effort === null ? 'null' : quote(effort));

const enabledValueOf = (enabled: boolean | null): string => (enabled === null ? 'null' : String(enabled));

const renderEntry = (entry: MenuMatrixEntry): string =>
    [
        '    {',
        `        model: ${quote(entry.model)},`,
        `        platform: ${quote(entry.platform)},`,
        `        vendorEfforts: ${effortListOf(entry.vendorEfforts)},`,
        `        vendorDefaultEffort: ${effortValueOf(entry.vendorDefaultEffort)},`,
        `        vendorToggle: ${String(entry.vendorToggle)},`,
        `        vendorDefaultEnabled: ${enabledValueOf(entry.vendorDefaultEnabled)},`,
        '    },',
    ].join('\n');

/** The whole snapshot file, byte-for-byte; the sync test compares it with the file on disk */
export const renderMenuMatrixFile = (entries: readonly MenuMatrixEntry[], generatedOn: string): string =>
    [
        '/**',
        " * The probe's menu matrix snapshot: the chat-menu models a default probe run covers,",
        ' * in menu order, with the reasoning facts from the capability seed.',
        ' *',
        ' * The probe CLI must not import `src/` (AGENTS: a script that imports src imports the',
        ' * offline harness first, whose `DB_PATH` rewrite would break the probe test-instance',
        " * gate), so this file is a snapshot. It is generated, never edited by hand:",
        ' *',
        ' *     npx tsx scripts/probe/refresh-menu-matrix.mts',
        ' *',
        ' * `scripts/offline/probe-matrix-sync.mts` fails when this snapshot and the runtime',
        ' * menu disagree, so a menu or seed change cannot silently ship a stale matrix.',
        ' *',
        ` * Generated on ${generatedOn} from the runtime menu config (modelConfigs) and`,
        ' * the capability seed (reasoning). Prices stay in effort-plan.',
        ' */',
        "import type { EffortValue, ProbePlatform } from './effort-types.mts';",
        '',
        '/** One chat-menu model the default probe matrix covers */',
        'export interface MenuMatrixEntry {',
        '    readonly model: string;',
        '    readonly platform: ProbePlatform;',
        '    readonly vendorEfforts: readonly EffortValue[];',
        '    readonly vendorDefaultEffort: EffortValue | null;',
        '    readonly vendorToggle: boolean;',
        '    readonly vendorDefaultEnabled: boolean | null;',
        '}',
        '',
        '/** The chat menu in order; regenerate with scripts/probe/refresh-menu-matrix.mts */',
        'export const MENU_MATRIX: readonly MenuMatrixEntry[] = [',
        ...entries.map(renderEntry),
        '];',
        '',
    ].join('\n');

/** The snapshot file as the refresher would write it now; the sync test compares it with disk */
export const renderCurrentMenuMatrixFile = (entries: readonly MenuMatrixEntry[]): string =>
    renderMenuMatrixFile(entries, generatedOnOf());

export interface MenuMatrixRefresh {
    readonly path: string;
    readonly changed: boolean;
    readonly models: number;
}

/** Write the snapshot if it differs; safe to run repeatedly (a second run is a no-op) */
export const refreshMenuMatrix = (): MenuMatrixRefresh => {
    const entries = menuMatrixEntriesFromRuntime();
    const source = renderMenuMatrixFile(entries, generatedOnOf());
    const current = existsSync(MENU_MATRIX_SOURCE_PATH) ? readFileSync(MENU_MATRIX_SOURCE_PATH, 'utf8') : '';
    const changed = current !== source;
    if (changed) writeFileSync(MENU_MATRIX_SOURCE_PATH, source);
    return { path: MENU_MATRIX_SOURCE_PATH, changed, models: entries.length };
};

// Importing this module (the sync test does) must not rewrite the snapshot
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    try {
        const result = refreshMenuMatrix();
        console.log(
            `[refresh] menu matrix: ${result.models} models, ${result.changed ? 'updated' : 'unchanged'} → ${result.path}`
        );
    } catch (error: unknown) {
        console.error(`[refresh] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
