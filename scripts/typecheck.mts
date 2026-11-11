/**
 * Type-checks the whole repository. Nothing is emitted.
 *
 *   pnpm typecheck             every project
 *   pnpm typecheck scripts     only the projects whose name contains the text
 *
 * Uses the native TypeScript 7 compiler from tools/typecheck when it is
 * installed (a few seconds per project). Without it, the 5.x compiler the
 * build uses does the same job with an incremental cache.
 *
 * The cache belongs to this command alone. `pnpm build` must never be
 * incremental: its cache would outlive a deleted dist/ and tsc would then emit
 * nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));

interface Project {
    name: string;
    /** tsconfig path, relative to the repository root */
    config: string;
}

const PROJECTS: readonly Project[] = [
    { name: 'src', config: 'tsconfig.json' },
    { name: 'scripts', config: 'tsconfig.scripts.json' },
    // Tests of browser code (scripts/offline/webapp-*.mts) need the DOM types
    { name: 'scripts-dom', config: 'tsconfig.scripts-dom.json' },
    { name: 'webapp', config: 'webapp/tsconfig.json' },
];

const NATIVE_COMPILER = join(REPOSITORY_ROOT, 'tools', 'typecheck', 'node_modules', '.bin', 'tsc');
const BUILD_COMPILER = join(REPOSITORY_ROOT, 'node_modules', '.bin', 'tsc');
const CACHE_DIRECTORY = join(REPOSITORY_ROOT, 'node_modules', '.cache', 'tsc');

const useNativeCompiler = existsSync(NATIVE_COMPILER);

const compilerArguments = (project: Project): string[] => {
    const shared = ['-p', project.config, '--noEmit', '--pretty', 'false'];
    if (useNativeCompiler) return shared;
    return [...shared, '--incremental', '--tsBuildInfoFile', join(CACHE_DIRECTORY, `${project.name}.tsbuildinfo`)];
};

/** Runs one project; true when it has no errors */
const check = (project: Project): boolean => {
    const startedAt = performance.now();
    const outcome = spawnSync(useNativeCompiler ? NATIVE_COMPILER : BUILD_COMPILER, compilerArguments(project), {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
    });
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    const output = `${outcome.stdout}${outcome.stderr}`.trim();
    const ok = outcome.status === 0;
    if (ok) {
        console.log(`PASS  ${project.name}  (${seconds}s)`);
        return true;
    }
    const errorCount = output.split('\n').filter((line) => line.includes('error TS')).length;
    console.log(`FAIL  ${project.name}  (${errorCount} errors, ${seconds}s)`);
    console.log(output);
    return false;
};

const nameFilters = process.argv.slice(2);
const selected = PROJECTS.filter(
    (project) => nameFilters.length === 0 || nameFilters.some((filter) => project.name.includes(filter))
);
if (selected.length === 0) {
    console.error(`no project matches; projects: ${PROJECTS.map((project) => project.name).join(', ')}`);
    process.exit(2);
}
if (!useNativeCompiler) {
    mkdirSync(CACHE_DIRECTORY, { recursive: true });
    console.log('native compiler not installed (pnpm install), using the build compiler');
}

// One at a time: each run can take about 1 GB and the host has little memory to spare
const failed = selected.filter((project) => !check(project));
if (failed.length > 0) {
    console.log(`\nFAILED: ${failed.map((project) => project.name).join(', ')}`);
    process.exitCode = 1;
}
