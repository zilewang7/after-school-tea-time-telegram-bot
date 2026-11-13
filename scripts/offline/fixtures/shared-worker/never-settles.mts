/** Fixture: waits at the top level for something that cannot happen */
import { reportResults } from '../../harness.mts';

// Node ends the process with 13 all the same: only another code than 0 would stay
process.exitCode = 0;
await new Promise(() => undefined);

reportResults([]);
