/**
 * Offline cases for the Gemini thought-summary filter.
 *
 * `gemini-4-carbon` hands back the thought summarizer's own generation as its
 * thinking: a "Thinking Process:" scaffold (restating instructions, drafting,
 * counting words) followed by the answer it finally wrote. The filter keeps
 * only those answers and passes every other stream through untouched.
 *
 * These cases pin:
 * - the pure extractor on five real production blocks: a draft glued to the
 *   final answer, a block that stops after its indented Final Polish draft, a
 *   truncated scaffold (dropped), one block carrying two updates, and a
 *   scaffold that quotes the "Thinking Process:" marker mid-block;
 * - the streaming filter: whole-push and arbitrary chunk delivery (cuts inside
 *   the marker, a step header and blank lines), the one-blank-line join between
 *   blocks, pass-through of non-summarizer streams, flush semantics and the
 *   counters;
 * - the one-line log for a reply.
 *
 * Run: npx tsx scripts/offline/gemini-thought-summary.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { THOUGHT_SUMMARY_FIXTURES } from './support/thought-summary-fixtures.mts';
import type { ThoughtSummaryStats } from '../../src/ai/platforms/gemini/gemini-thought-summary.js';

const loadFilterModule = () => import('../../src/ai/platforms/gemini/gemini-thought-summary.js');

interface FilterRun {
    /** What every push returned, in order */
    readonly pieces: readonly string[];
    /** What flush returned */
    readonly flushed: string;
    /** Everything the display and the stored version would receive */
    readonly text: string;
    readonly stats: ThoughtSummaryStats;
}

/** Feed `chunks` through a fresh filter, then flush it */
const runFilter = async (chunks: readonly string[]): Promise<FilterRun> => {
    const { createThoughtSummaryFilter } = await loadFilterModule();
    const filter = createThoughtSummaryFilter();
    const pieces = chunks.map((chunk) => filter.push(chunk));
    const flushed = filter.flush();
    return { pieces, flushed, text: `${pieces.join('')}${flushed}`, stats: filter.stats() };
};

/** Split into chunks of at most `size` characters */
const chunksOfSize = (text: string, size: number): string[] => {
    const chunks: string[] = [];
    for (let start = 0; start < text.length; start += size) chunks.push(text.slice(start, start + size));
    return chunks;
};

/** Split at the given offsets, in order */
const chunksAt = (text: string, cuts: readonly number[]): string[] => {
    const chunks: string[] = [];
    let start = 0;
    for (const cut of cuts) {
        chunks.push(text.slice(start, cut));
        start = cut;
    }
    chunks.push(text.slice(start));
    return chunks;
};

/** A fixture by index, failing loudly instead of yielding undefined */
const fixtureAt = (index: number) => {
    const fixture = THOUGHT_SUMMARY_FIXTURES[index];
    if (fixture === undefined) throw new Error(`thought-summary fixture ${index} is missing`);
    return fixture;
};

const expectStats = (actual: ThoughtSummaryStats, expected: ThoughtSummaryStats, label: string): void => {
    expect(
        actual.detected === expected.detected &&
            actual.rawChars === expected.rawChars &&
            actual.cleanChars === expected.cleanChars &&
            actual.blocks === expected.blocks &&
            actual.summaries === expected.summaries &&
            actual.dropped === expected.dropped,
        `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
    );
};

/** A dropped block warns by design; mute it while that outcome is expected */
const withMutedWarnings = async (body: () => Promise<void>): Promise<void> => {
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
        await body();
    } finally {
        console.warn = originalWarn;
    }
};

const results: CaseResult[] = [];

results.push(
    await runCase('extract returns no summary for an empty block, a bare scaffold or prose', async () => {
        const { extractThoughtSummaries } = await loadFilterModule();

        expect(extractThoughtSummaries('').length === 0, 'an empty block carries no summary');
        expect(
            extractThoughtSummaries('Thinking Process:\n\n').length === 0,
            'a bare signature carries no summary'
        );
        expect(
            extractThoughtSummaries('Thinking Process:\n\n1.  **Analyze the Request:**\n\n').length === 0,
            'a numbered step without an answer carries no summary'
        );
        expect(
            extractThoughtSummaries('plain prose without any bold heading').length === 0,
            'prose without a heading is not a summary'
        );
        // A candidate whose paragraph is a list item is scaffold, not the answer
        expect(
            extractThoughtSummaries('**Header**\n\n* a bullet point').length === 0,
            'a bullet paragraph does not count as the answer'
        );
    })
);

results.push(
    await runCase('extract keeps the final answer of a normal block and drops its scaffold', async () => {
        const { extractThoughtSummaries } = await loadFilterModule();
        const fixture = fixtureAt(0);
        const summaries = extractThoughtSummaries(fixture.raw);

        expect(summaries.length === 1, `one summary comes out of the block (got ${summaries.length})`);
        expect(
            summaries[0] === fixture.expected,
            `the summary is the fixture's expected text (got ${JSON.stringify(summaries[0])})`
        );
        expect(summaries.join('\n\n') === fixture.expected, 'joining the summaries reproduces the expected text');
        const [summary = ''] = summaries;
        expect(
            summary.startsWith('**Unpacking linguistic mechanisms behind loanwords**\n\n'),
            'the answer keeps its header and the blank line after it'
        );
        expect(
            !summary.includes('Analyze the Request') && !summary.includes('Final Polish'),
            'no scaffold step reaches the summary'
        );
        expect(
            summary.endsWith('explaining its surprising ubiquity across Chinese digital spaces.'),
            'the next update\'s header glued to the draft paragraph is stripped'
        );
        expect(!/^\s/.test(summary), 'the indented Final Polish draft is trimmed');
    })
);

results.push(
    await runCase('extract falls back to the indented Final Polish draft when the block stops there', async () => {
        const { extractThoughtSummaries } = await loadFilterModule();
        const fixture = fixtureAt(1);
        const summaries = extractThoughtSummaries(fixture.raw);

        expect(summaries.length === 1, `the draft is the only summary (got ${summaries.length})`);
        expect(
            summaries[0] === fixture.expected,
            `the trimmed draft is the expected text (got ${JSON.stringify(summaries[0])})`
        );
        const [summary = ''] = summaries;
        expect(
            summary.startsWith('**Investigating regional geography and platform algorithms**\n\n'),
            'the draft keeps its header and blank line'
        );
        expect(!/\n {2,}/.test(summary), 'no indented scaffold line survives in the summary');
        // The block really ends after the indented draft: no unindented answer follows it
        expect(
            fixture.raw.includes(
                '    **Investigating regional geography and platform algorithms**\n\n    I am now looking'
            ),
            'the fixture really stops at an indented draft (sanity)'
        );
        expect(
            fixture.raw.trimEnd().endsWith(fixture.expected.slice(fixture.expected.indexOf('\n\n') + 2)),
            'the expected paragraph is the draft paragraph, trimmed (sanity)'
        );
    })
);

results.push(
    await runCase('extract discards a truncated scaffold instead of emitting its last header', async () => {
        const { extractThoughtSummaries } = await loadFilterModule();
        const fixture = fixtureAt(2);
        const summaries = extractThoughtSummaries(fixture.raw);

        expect(summaries.length === 0, `no summary comes out of the truncated block (got ${summaries.length})`);
        expect(summaries.join('\n\n') === fixture.expected, 'the expected text is empty');
        expect(fixture.raw.includes('6.  **Generate Output.**'), 'the block really stops at its last header (sanity)');
        expect(
            !JSON.stringify(summaries).includes('Generate Output'),
            'the header-only fallback is not applied'
        );
    })
);

results.push(
    await runCase('extract keeps both updates of a block that carries two summaries, in order', async () => {
        const { extractThoughtSummaries } = await loadFilterModule();
        const fixture = fixtureAt(3);
        const summaries = extractThoughtSummaries(fixture.raw);

        expect(summaries.length === 2, `both updates are kept (got ${summaries.length})`);
        expect(
            summaries[0]?.startsWith('**Anticipating the streaming ban consequences**\n\n') === true,
            'the first update comes first'
        );
        expect(
            summaries[1]?.startsWith('**Formulating the final witty response**\n\n') === true,
            'the second update follows it'
        );
        expect(summaries.join('\n\n') === fixture.expected, 'both updates, one blank line apart, are the expected text');
        expect(
            (summaries[0] ?? '').includes('privacy lockdown or ban') &&
                (summaries[1] ?? '').includes('insider-joke-filled reply'),
            'each summary keeps its own paragraph'
        );
    })
);

results.push(
    await runCase('extract does not split a block that quotes the Thinking Process marker', async () => {
        const { extractThoughtSummaries } = await loadFilterModule();
        const fixture = fixtureAt(4);
        const quotedAt = fixture.raw.indexOf('Thinking Process:', 1);

        expect(quotedAt !== -1, 'the block quotes the marker again (sanity)');
        const summaries = extractThoughtSummaries(fixture.raw);
        expect(summaries.length === 1, `the quoted marker does not split the block (got ${summaries.length})`);
        expect(
            summaries[0] === fixture.expected,
            `the final answer is still extracted (got ${JSON.stringify(summaries[0])})`
        );
        expect(
            (summaries[0] ?? '').includes('Thinking Process') === false &&
                (summaries[0] ?? '').includes('Existing Summary') === false,
            'the quoted scaffold text is not part of the summary'
        );
    })
);

results.push(
    await runCase('every production block through the filter yields exactly its expected summaries', async () => {
        await withMutedWarnings(async () => {
            for (const [index, fixture] of THOUGHT_SUMMARY_FIXTURES.entries()) {
                const run = await runFilter([fixture.raw]);
                expect(
                    run.pieces[0] === '',
                    `fixture ${index}: a single-block stream releases nothing before the block ends`
                );
                expect(
                    run.flushed === fixture.expected,
                    `fixture ${index}: flush releases the expected text (got ${JSON.stringify(run.flushed)})`
                );
                expect(run.text === fixture.expected, `fixture ${index}: the whole output is the expected text`);
                expect(
                    !run.text.includes('Analyze the Request') && !run.text.includes('Thinking Process:'),
                    `fixture ${index}: no scaffold reaches the display`
                );
            }
        });
    })
);

results.push(
    await runCase('a whole multi-block stream releases the first block at once and joins blocks with one blank line', async () => {
        const first = fixtureAt(0);
        const second = fixtureAt(3);
        const multi = `${first.raw}\n\n${second.raw}`;
        const expected = `${first.expected}\n\n${second.expected}`;
        const run = await runFilter([multi]);

        expect(multi.indexOf('Thinking Process:', 1) !== -1, 'the constructed text has a real second block start');
        expect(run.pieces[0] === first.expected, 'the completed first block is released by the push that starts the second');
        expect(
            run.flushed === `\n\n${second.expected}`,
            `flush releases the pending block after exactly one blank line (got ${JSON.stringify(run.flushed.slice(0, 20))})`
        );
        expect(run.text === expected, 'the whole output is both blocks in order');
        expectStats(
            run.stats,
            {
                detected: true,
                rawChars: multi.length,
                cleanChars: first.expected.length + second.expected.length,
                blocks: 2,
                summaries: 3,
                dropped: 0,
            },
            'two-block stream'
        );
    })
);

results.push(
    await runCase('chunked delivery of the multi-block stream matches the whole-push output', async () => {
        const first = fixtureAt(0);
        const second = fixtureAt(3);
        const multi = `${first.raw}\n\n${second.raw}`;
        const expected = `${first.expected}\n\n${second.expected}`;
        const baseline = await runFilter([multi]);

        for (const size of [1, 3, 7, 40]) {
            const chunks = chunksOfSize(multi, size);
            const run = await runFilter(chunks);
            expect(run.pieces.length === chunks.length, `size ${size}: every chunk was pushed`);
            expect(run.text === expected, `size ${size}: chunked delivery reproduces the whole-push output`);
            expectStats(run.stats, baseline.stats, `size ${size}: chunking does not change the counters`);
            expect(
                !run.text.includes('Analyze the Request') && !run.text.includes('Final Polish'),
                `size ${size}: no scaffold reaches the display`
            );
        }
    })
);

results.push(
    await runCase('splitting inside the marker, a step header or a blank line changes nothing', async () => {
        const first = fixtureAt(0);
        const second = fixtureAt(3);
        const multi = `${first.raw}\n\n${second.raw}`;
        const expected = `${first.expected}\n\n${second.expected}`;
        const marker2 = multi.indexOf('Thinking Process:', 1);
        const marker = 'Thinking Process:';
        const step2 = multi.indexOf('**Analyze the Request:**', marker2);
        const step = '**Analyze the Request:**';
        const answerHeading = '**Unpacking linguistic mechanisms behind loanwords**';
        const answerHeadingAt = multi.lastIndexOf(answerHeading, marker2);
        const secondUpdate = multi.indexOf('**Formulating the final witty response**', marker2);

        expect(marker2 > 0, 'the second block start exists');
        expect(multi.slice(marker2, marker2 + marker.length) === marker, 'the second block starts with the marker (sanity)');
        expect(multi.slice(marker2 - 2, marker2) === '\n\n', 'blocks are separated by one blank line (sanity)');
        expect(step2 > marker2, 'the second block has a numbered step header (sanity)');
        expect(multi.slice(step2, step2 + step.length) === step, 'the step header is where it is expected (sanity)');
        expect(answerHeadingAt > 0, 'the first block has a final answer heading (sanity)');
        expect(
            multi.slice(answerHeadingAt + answerHeading.length, answerHeadingAt + answerHeading.length + 2) === '\n\n',
            'the answer heading is followed by a blank line (sanity)'
        );
        expect(secondUpdate > marker2, 'the last block carries a second update (sanity)');
        expect(multi.slice(secondUpdate - 2, secondUpdate) === '\n\n', 'the two updates are separated by a blank line (sanity)');

        const cuts: readonly { readonly what: string; readonly cut: number }[] = [
            { what: 'at the block boundary', cut: marker2 },
            { what: 'inside the block marker', cut: marker2 + 7 },
            { what: 'inside the numbered step header', cut: step2 + 6 },
            { what: 'between the two newlines separating the blocks', cut: marker2 - 1 },
            { what: 'inside the answer heading', cut: answerHeadingAt + 10 },
            {
                what: 'between the answer heading and its paragraph',
                cut: answerHeadingAt + answerHeading.length + 1,
            },
            { what: 'between the two newlines before the second update', cut: secondUpdate - 1 },
        ];
        const baseline = await runFilter([multi]);
        for (const { what, cut } of cuts) {
            expect(cut > 0 && cut < multi.length, `the cut ${what} is inside the text (sanity)`);
            const run = await runFilter(chunksAt(multi, [cut]));
            expect(
                run.text === expected,
                `a split ${what} changes nothing (got ${JSON.stringify(run.text.slice(0, 40))})`
            );
            expectStats(run.stats, baseline.stats, `a split ${what}`);
        }

        const manyCuts = [...new Set(cuts.map(({ cut }) => cut))].sort((left, right) => left - right);
        expect(manyCuts.length === cuts.length, 'the cut positions are distinct');
        const allAtOnce = await runFilter(chunksAt(multi, manyCuts));
        expect(allAtOnce.text === expected, 'splitting at every boundary at once changes nothing');
        expectStats(allAtOnce.stats, baseline.stats, 'every boundary split at once');
    })
);

results.push(
    await runCase('a non-summarizer stream passes through byte for byte, first chunk included', async () => {
        const clean = '**Heading**\n\nparagraph one\n\n**Heading2**\n\nparagraph two';
        const firstChunk = '**Heading**\n\nparagraph one';
        const single = await runFilter([firstChunk]);

        expect(single.pieces[0] === firstChunk, 'the first chunk is returned immediately, with no buffering');
        expect(single.flushed === '', 'nothing is left for flush');
        expect(single.stats.detected === false, 'the stream is not a summarizer stream');

        const full = await runFilter([clean]);
        expect(full.text === clean, 'a one-push stream comes out byte-identical');
        expectStats(
            full.stats,
            { detected: false, rawChars: clean.length, cleanChars: 0, blocks: 0, summaries: 0, dropped: 0 },
            'pass-through counters'
        );

        for (const size of [1, 3, 7]) {
            const chunks = chunksOfSize(clean, size);
            const run = await runFilter(chunks);
            expect(run.text === clean, `size ${size}: chunked pass-through is byte-identical`);
            expect(
                run.pieces.every((piece, index) => piece === chunks[index]),
                `size ${size}: every chunk is returned as-is`
            );
            expect(run.stats.detected === false, `size ${size}: still not a summarizer stream`);
            expect(run.stats.rawChars === clean.length, `size ${size}: raw characters are still counted`);
        }
    })
);

results.push(
    await runCase('a stream that only starts like the marker is released whole once it diverges', async () => {
        const text = 'Thinking Process:\n\nThis is prose, not a numbered step.';
        const run = await runFilter(['Thinking Process:', '\n\nThis is prose, not a numbered step.']);

        expect(run.pieces[0] === '', 'a chunk that could still become the signature is held');
        expect(
            run.pieces[1] === text,
            `once the prefix diverges the whole held text is released unchanged (got ${JSON.stringify(run.pieces[1])})`
        );
        expect(run.flushed === '', 'nothing is left for flush');
        expect(run.text === text, 'no byte is lost on the pass-through decision');
        expect(run.stats.detected === false, 'the diverging prefix is not detected as a summarizer stream');
        expect(run.stats.rawChars === text.length, 'raw characters are still counted');
    })
);

results.push(
    await runCase('an empty or blank stream is released unchanged and never detected', async () => {
        const empty = await runFilter([]);
        expect(empty.text === '', 'an empty stream produces nothing');
        expect(empty.stats.rawChars === 0 && empty.stats.blocks === 0, 'an empty stream has no counters');
        expect(empty.stats.detected === false, 'an empty stream is not detected');

        const blankText = '  \n\t \n';
        const blank = await runFilter(['', blankText]);
        expect(blank.pieces[0] === '', 'an empty chunk returns nothing');
        expect(blank.pieces[1] === '', 'blank space is held while the stream could still become the signature');
        expect(blank.flushed === blankText, 'flush releases the held blank space unchanged');
        expect(blank.text === blankText, 'no byte of the blank stream is lost');
        expect(blank.stats.detected === false, 'blank space is not a summarizer stream');
        expect(blank.stats.rawChars === blankText.length, 'the blank characters are still counted as raw');

        const { createThoughtSummaryFilter } = await loadFilterModule();
        const filter = createThoughtSummaryFilter();
        expect(filter.push(blankText) === '', 'the blank push itself releases nothing');
        expect(filter.flush() === blankText, 'the first flush releases the held blank space');
        expect(filter.flush() === '', 'a second flush releases nothing');
    })
);

results.push(
    await runCase('a stream that ends inside the detection signature never leaks the scaffold', async () => {
        // Still a partial signature: it cannot be a block start yet, so it passes through
        const partial = 'Thinking Process:\n\n1.  *';
        const partialRun = await runFilter([partial]);
        expect(partialRun.pieces[0] === '', 'the partial signature is held');
        expect(partialRun.flushed === partial, 'flush releases a partial signature unchanged');
        expect(partialRun.text === partial, 'the partial signature is passed through');
        expect(partialRun.stats.detected === false, 'an incomplete signature is not detected');

        // Complete prefix but no step content: a summarizer stream cut before its answer
        await withMutedWarnings(async () => {
            const complete = 'Thinking Process:\n\n1.  **';
            const run = await runFilter([complete]);
            expect(run.pieces[0] === '', 'the complete prefix releases nothing');
            expect(run.flushed === '', 'flush drops the incomplete block');
            expect(run.text === '', 'no scaffold reaches the display');
            expect(run.stats.detected === true, 'the complete prefix is detected as a summarizer stream');
            expect(
                run.stats.blocks === 1 && run.stats.summaries === 0 && run.stats.dropped === 1,
                `the incomplete block counts as dropped, not summarised (got ${JSON.stringify(run.stats)})`
            );
        });
    })
);

results.push(
    await runCase('flush releases a complete block once and nothing afterwards', async () => {
        const fixture = fixtureAt(0);
        const { createThoughtSummaryFilter } = await loadFilterModule();
        const filter = createThoughtSummaryFilter();

        expect(filter.push(fixture.raw) === '', 'a complete block is not released while it is the only block');
        expect(filter.flush() === fixture.expected, 'flush releases the complete block');
        expect(filter.flush() === '', 'a second flush releases nothing');
        expect(
            filter.stats().blocks === 1 && filter.stats().summaries === 1 && filter.stats().dropped === 0,
            `the second flush does not change the counters (got ${JSON.stringify(filter.stats())})`
        );
    })
);

results.push(
    await runCase('flush after a mid-block truncation returns nothing', async () => {
        const fixture = fixtureAt(0);
        const half = fixture.raw.slice(0, Math.floor(fixture.raw.length / 2));

        await withMutedWarnings(async () => {
            const run = await runFilter([half]);
            expect(run.pieces[0] === '', 'an unfinished block releases nothing');
            expect(run.flushed === '', 'flush releases nothing for a block cut before its answer');
            expect(run.text === '', 'no scaffold reaches the display');
            expectStats(
                run.stats,
                {
                    detected: true,
                    rawChars: half.length,
                    cleanChars: 0,
                    blocks: 1,
                    summaries: 0,
                    dropped: 1,
                },
                'truncated block'
            );
        });
    })
);

results.push(
    await runCase('stats count the raw, clean, block, summary and drop totals', async () => {
        const first = fixtureAt(0);
        const second = fixtureAt(3);
        const truncated = fixtureAt(2);

        const firstRun = await runFilter([first.raw]);
        expectStats(
            firstRun.stats,
            {
                detected: true,
                rawChars: first.raw.length,
                cleanChars: first.expected.length,
                blocks: 1,
                summaries: 1,
                dropped: 0,
            },
            'one normal block'
        );

        const multi = `${first.raw}\n\n${second.raw}`;
        const multiRun = await runFilter([multi]);
        expectStats(
            multiRun.stats,
            {
                detected: true,
                rawChars: multi.length,
                cleanChars: first.expected.length + second.expected.length,
                blocks: 2,
                summaries: 3,
                dropped: 0,
            },
            'two blocks with three summaries'
        );

        await withMutedWarnings(async () => {
            const droppedRun = await runFilter([truncated.raw]);
            expectStats(
                droppedRun.stats,
                {
                    detected: true,
                    rawChars: truncated.raw.length,
                    cleanChars: 0,
                    blocks: 1,
                    summaries: 0,
                    dropped: 1,
                },
                'a truncated block'
            );
        });

        const clean = '**Heading**\n\nparagraph';
        const passthroughRun = await runFilter([clean]);
        expectStats(
            passthroughRun.stats,
            { detected: false, rawChars: clean.length, cleanChars: 0, blocks: 0, summaries: 0, dropped: 0 },
            'a pass-through stream'
        );
    })
);

results.push(
    await runCase('a dropped block adds no separator to the stream', async () => {
        const first = fixtureAt(0);
        const truncated = fixtureAt(2);
        const multi = `${first.raw}\n\n${truncated.raw}`;

        await withMutedWarnings(async () => {
            const whole = await runFilter([multi]);
            expect(whole.pieces[0] === first.expected, 'the completed block is released');
            expect(whole.flushed === '', 'the dropped block releases nothing');
            expect(whole.text === first.expected, 'no blank line is left behind by the dropped block');
            expectStats(
                whole.stats,
                {
                    detected: true,
                    rawChars: multi.length,
                    cleanChars: first.expected.length,
                    blocks: 2,
                    summaries: 1,
                    dropped: 1,
                },
                'one kept and one dropped block'
            );

            for (const size of [1, 7, 40]) {
                const chunked = await runFilter(chunksOfSize(multi, size));
                expect(
                    chunked.text === first.expected,
                    `size ${size}: chunked delivery also leaves no trailing separator`
                );
                expectStats(chunked.stats, whole.stats, `size ${size}: dropped-block counters`);
            }
        });
    })
);

results.push(
    await runCase('thoughtSummaryLogLine is null for a pass-through stream and counts everything otherwise', async () => {
        const { thoughtSummaryLogLine } = await loadFilterModule();
        const first = fixtureAt(0);
        const truncated = fixtureAt(2);

        const filtered = await runFilter([first.raw]);
        const line = thoughtSummaryLogLine('gemini-4-carbon', filtered.stats);
        expect(
            line ===
                `[gemini] gemini-4-carbon thought summaries filtered raw=${first.raw.length} ` +
                    `clean=${first.expected.length} blocks=1 summaries=1 dropped=0`,
            `the filtered line carries every counter (got ${JSON.stringify(line)})`
        );
        expect(
            (line ?? '').includes('raw=') && (line ?? '').includes('clean=') && (line ?? '').includes('blocks='),
            'the line names raw, clean and block counters'
        );

        const passthrough = await runFilter(['**Heading**\n\nparagraph']);
        expect(
            thoughtSummaryLogLine('gemini-4-argon', passthrough.stats) === null,
            'a pass-through stream logs nothing'
        );

        await withMutedWarnings(async () => {
            const dropped = await runFilter([truncated.raw]);
            const droppedLine = thoughtSummaryLogLine('gemini-4-carbon', dropped.stats);
            expect(
                droppedLine !== null &&
                    droppedLine.includes(`raw=${truncated.raw.length}`) &&
                    droppedLine.includes('clean=0') &&
                    droppedLine.includes('dropped=1'),
                `the dropped-block line reports the drop (got ${JSON.stringify(droppedLine)})`
            );
        });
    })
);

reportResults(results);
