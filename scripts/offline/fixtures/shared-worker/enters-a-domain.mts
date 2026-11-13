/** Fixture: passes, and is still inside a domain of node:domain when it ends */
import { create } from 'node:domain';
import { expect, reportResults, runCase } from '../../harness.mts';
import { noteProcess } from './support.mts';

const results = [
    await runCase('leaves a domain entered', () => {
        noteProcess('enters-a-domain');
        const domain = create();
        // Would take every uncaught error from here on, a later file's too
        domain.on('error', () => undefined);
        try {
            domain.run(() => {
                throw new Error('thrown inside the domain');
            });
        } catch {
            // `run` did not get to leave the domain
        }
        expect(Reflect.get(process, 'domain') === domain, 'the domain is still the active one');
    }),
];

reportResults(results);
