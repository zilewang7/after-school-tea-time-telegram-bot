/** Fixture: waits at the top level for something that cannot happen */
import { reportResults } from '../../harness.mts';

await new Promise(() => undefined);

reportResults([]);
