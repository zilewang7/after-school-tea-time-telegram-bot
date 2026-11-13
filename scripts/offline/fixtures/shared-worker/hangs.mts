/** Fixture: never ends, and has started a child process that would not end soon either */
import { spawn } from 'node:child_process';
import { reportResults } from '../../harness.mts';
import { appendToScratch, noteProcess } from './support.mts';

noteProcess('hangs');
const child = spawn('sleep', ['60'], { stdio: 'ignore' });
appendToScratch('pid-child-of-hangs', `${child.pid}\n`);

setInterval(() => undefined, 1000);
await new Promise(() => undefined);

reportResults([]);
