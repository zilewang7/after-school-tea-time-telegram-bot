/**
 * Gives every test file of a shared worker its own copy of the repository's
 * modules.
 *
 * The worker imports test file number N as `…/name.mts?g=N`. Whatever a module
 * with that query imports gets the same query, unless it is a package in
 * node_modules. Node keeps one module instance per URL, so each test file sees
 * freshly evaluated `src/` and `scripts/` modules (their module-level state,
 * the env values they read at import) while the packages stay loaded once per
 * worker. Loading the packages is most of what a test process costs.
 */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const GENERATION_PATTERN = /[?&]g=(\w+)/;

const generationOf = (url: string | undefined): string | undefined =>
    url === undefined ? undefined : GENERATION_PATTERN.exec(url)?.[1];

/** Packages are shared by every test file of a worker; everything else on disk is reloaded */
const isReloaded = (url: string): boolean => url.startsWith('file:') && !url.includes('/node_modules/');

export const registerFreshModules = (): void => {
    registerHooks({
        resolve(specifier, context, nextResolve) {
            const resolved = nextResolve(specifier, context);
            const generation = generationOf(context.parentURL);
            if (generation === undefined || !isReloaded(resolved.url)) return resolved;
            if (generationOf(resolved.url) !== undefined) return resolved;
            const separator = resolved.url.includes('?') ? '&' : '?';
            return { ...resolved, url: `${resolved.url}${separator}g=${generation}` };
        },
    });
};

/** The URL under which a worker imports `path` for one test file */
export const freshUrlOf = (path: string, generation: number | string): string =>
    `${pathToFileURL(path).href}?g=${generation}`;
