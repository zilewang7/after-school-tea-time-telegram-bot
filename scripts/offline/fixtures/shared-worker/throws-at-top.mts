/** Fixture: throws outside of any case, with a server still listening */
import { createServer } from 'node:http';
import '../../harness.mts';

const server = createServer();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

throw new Error('thrown at the top level');
