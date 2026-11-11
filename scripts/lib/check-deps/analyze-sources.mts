import { analyzeFacts, type Findings } from './analyze.mts';
import { factsOf } from './file-facts.mts';

/** Parses every source (repository-relative path → text) and runs the rules; no cache */
export const analyzeSources = (sources: ReadonlyMap<string, string>): Findings =>
    analyzeFacts(new Map([...sources].map(([path, text]) => [path, factsOf(path, text)] as const)));
