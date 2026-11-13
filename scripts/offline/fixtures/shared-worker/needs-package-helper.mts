/** Fixture: runs after uses-package-helper.mts in the same worker and needs the package's helper process */
import { readFileSync } from 'node:fs';
import { expect, reportResults, runCase } from '../../harness.mts';
import { isRunning } from '../../support/scratch-directory.mts';
import { noteProcess, scratchPath } from './support.mts';

const results = [
    await runCase('the helper process of the package still runs', () => {
        noteProcess('needs-package-helper');
        const helper = Number(readFileSync(scratchPath('pid-package-helper'), 'utf8'));
        // A package is loaded once per worker: it would not start its helper again
        expect(isRunning(helper), `process ${helper} is running`);
    }),
];

reportResults(results);
