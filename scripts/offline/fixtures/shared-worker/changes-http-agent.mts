/** Fixture: passes, and changes an object no worker puts back */
import http from 'node:http';
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('limits the global agent', () => {
        http.globalAgent.maxSockets = 7;
        expect(http.globalAgent.maxSockets === 7, 'the limit is set');
    }),
];

reportResults(results);
