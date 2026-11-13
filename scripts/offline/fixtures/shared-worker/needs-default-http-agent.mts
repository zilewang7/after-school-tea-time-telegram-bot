/** Fixture: passes on its own, fails in a worker that ran changes-http-agent.mts before */
import http from 'node:http';
import { expect, reportResults, runCase } from '../../harness.mts';

const results = [
    await runCase('the global agent has its default limit', () => {
        expect(http.globalAgent.maxSockets !== 7, 'nobody limited the global agent');
    }),
];

reportResults(results);
