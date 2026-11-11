import { createRequire } from 'node:module';
import type * as TypeScript from 'typescript';

/**
 * The TypeScript compiler API, loaded with require. An ESM `import` of this
 * 9 MB CommonJS file first scans it for named exports, which doubles the load
 * time (about 1.0 s against 0.5 s under tsx) and the guard has a 2 s budget.
 */
export const ts: typeof TypeScript = createRequire(import.meta.url)('typescript');
