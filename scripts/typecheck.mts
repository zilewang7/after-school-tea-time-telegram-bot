/**
 * Type-checks the whole repository. Nothing is emitted.
 *
 *   pnpm typecheck             every project
 *   pnpm typecheck scripts     only the projects whose name contains the text
 *
 * The compiler is the one the build uses: the native TypeScript 7 of the root
 * package. It takes a few seconds per project, so nothing is cached.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

const COMPILER = join(REPOSITORY_ROOT, 'node_modules', '.bin', 'tsc');

/** Runs one project; true when it has no errors */
const check = (project: Project): boolean => {
    const startedAt = performance.now();
    const outcome = spawnSync(COMPILER, ['-p', project.config, '--noEmit', '--pretty', 'false'], {
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
if (!existsSync(COMPILER)) {
    console.error('the compiler is not installed; run `pnpm install` in the main checkout');
    process.exit(2);
}

// One at a time: each run can take about 1 GB and the host has little memory to spare
const failed = selected.filter((project) => !check(project));
if (failed.length > 0) {
    console.log(`\nFAILED: ${failed.map((project) => project.name).join(', ')}`);
    process.exitCode = 1;
}
