/** Fixture: never ends */
import { reportResults } from '../../harness.mts';

setInterval(() => undefined, 1000);
await new Promise(() => undefined);

reportResults([]);
