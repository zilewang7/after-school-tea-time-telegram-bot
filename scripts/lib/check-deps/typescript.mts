import { createRequire } from 'node:module';
import type * as TypeScript from '@typescript/typescript6';

/**
 * The TypeScript compiler API. TypeScript 7.0, which builds and type-checks
 * this repository, ships without one; `@typescript/typescript6` is the
 * official package that still carries the 6.0 API, and parsing is all the
 * guard needs from it.
 *
 * Loaded with require: an ESM `import` of this 9 MB CommonJS file first scans
 * it for named exports, which doubles the load time (about 1.0 s against
 * 0.5 s under tsx) and the guard has a 2 s budget.
 */
export const ts: typeof TypeScript = createRequire(import.meta.url)('@typescript/typescript6');
