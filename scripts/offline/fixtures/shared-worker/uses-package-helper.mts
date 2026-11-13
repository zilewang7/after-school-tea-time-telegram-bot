/** Fixture: passes, having made a package start a timer and a helper process, neither of which keeps the file running */
import { expect, reportResults, runCase } from '../../harness.mts';
import { appendToScratch, importFixturePackage, noteProcess, scratchPath } from './support.mts';

const results = [
    await runCase('makes a package start a timer and a helper process', async () => {
        noteProcess('uses-package-helper');
        const fixturePackage = await importFixturePackage();
        fixturePackage.startTicker(scratchPath('package-ticks'));
        const helper = fixturePackage.startHelper();
        appendToScratch('pid-package-helper', `${helper}\n`);
        expect(helper !== undefined, 'the helper process started');
    }),
];

reportResults(results);
