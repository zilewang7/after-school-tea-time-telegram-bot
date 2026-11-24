/**
 * Offline cases for the repository skill registry, catalog tail, load_skill tool,
 * and the four built-in skills under skills/*. No DB, no network.
 *
 * Run: npx tsx scripts/offline/skill-registry.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedMessage } from '../../src/ai/types.js';
import { compileA2uiSurface } from '../../src/ai/widget/a2ui/compile.js';
import { WIDGET_GUIDE_VERSION } from '../../src/ai/widget/guides/registry.js';
import { estimateRetainedBytes } from '../../src/reply/resume/checkpoint-size.js';
import {
    appendSkillCatalogTail,
    buildSkillCatalogSection,
    SKILL_CATALOG_DESCRIPTION_MAX_CHARS,
    SKILL_CATALOG_MAX_CHARS,
} from '../../src/reply/skills/skill-catalog-tail.js';
import {
    filterAvailableSkills,
    getSkillRegistry,
    loadSkillsFromDirectory,
    parseAndValidateSkill,
    resetSkillRegistryCache,
    SKILL_MAX_BODY_CHARS,
    SKILL_MAX_BODY_LINES,
    SKILL_MAX_COUNT,
    WIDGET_ALLOW_HTML_FLAG,
    type SkillEntry,
} from '../../src/reply/skills/skill-registry.js';
import {
    createLoadSkillTool,
    createSkillToolState,
} from '../../src/reply/tools/load-skill-tool.js';
import { LOAD_SKILL_TOOL_NAME } from '../../src/reply/tools/tool-names.js';
import { TOOL_GROUP_KEYS } from '../../src/services/tool-overrides.js';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'k-on-skill-registry-'));
process.once('exit', () => {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
});

let tempCounter = 0;
const makeTempSkillsDir = (): string => {
    tempCounter += 1;
    const dir = join(TEMP_ROOT, `case-${tempCounter}`);
    mkdirSync(dir, { recursive: true });
    return dir;
};

const writeSkillFile = (rootDir: string, dirName: string, content: string): void => {
    const skillDir = join(rootDir, dirName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf8');
};

const withCapturedWarn = <T,>(fn: () => T): { readonly result: T; readonly warnings: readonly string[] } => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map((item) => String(item)).join(' '));
    };
    try {
        return { result: fn(), warnings };
    } finally {
        console.warn = originalWarn;
    }
};

const makeDummySkill = (overrides: Partial<SkillEntry> = {}): SkillEntry => ({
    name: 'sample-skill',
    description: '示例技能说明',
    body: '# 示例正文\n\n内容。',
    version: '1',
    requiredTools: [],
    anyTools: [],
    requiredFlags: [],
    scope: 'all',
    ownerOnly: false,
    source: 'repo',
    ...overrides,
});

const cases: CaseResult[] = [];

cases.push(
    await runCase('frontmatter parses folded/literal descriptions, quotes, comments and metadata', async () => {
        const raw = [
            '---',
            'name: demo-skill # inline comment',
            'description: >',
            '  第一行说明文字',
            '  第二行继续拼接',
            'license: "MIT"',
            "compatibility: 'it''s fine # kept'",
            'metadata:',
            '  bot.required-tools: "send_widget, workspace"',
            '  bot.any-tools: "history, find_image"',
            '  bot.required-flags: "widget-allow-html"',
            '  bot.scope: "group"',
            '  bot.owner-only: "true"',
            '  bot.version: "4"',
            '  bot.unknown-key: "ignored"',
            '---',
            '正文第一行\r\n正文第二行',
        ]
            .join('\r\n');

        const parsed = parseAndValidateSkill('demo-skill', raw);
        expect(parsed.ok, 'valid skill parses');
        if (!parsed.ok) return;
        expect(parsed.entry.name === 'demo-skill', 'name matches');
        expect(
            parsed.entry.description === '第一行说明文字 第二行继续拼接',
            'folded description joins lines with space'
        );
        expect(parsed.entry.requiredTools.join(',') === 'send_widget,workspace', 'requiredTools parsed');
        expect(parsed.entry.anyTools.join(',') === 'history,find_image', 'anyTools parsed');
        expect(parsed.entry.requiredFlags.join(',') === 'widget-allow-html', 'requiredFlags parsed');
        expect(parsed.entry.scope === 'group', 'scope parsed');
        expect(parsed.entry.ownerOnly === true, 'ownerOnly parsed');
        expect(parsed.entry.version === '4', 'version parsed');
        expect(!parsed.entry.body.includes('\r'), 'CRLF normalized to LF');
        expect(parsed.entry.body === '正文第一行\n正文第二行', 'body preserved');

        const literalRaw = [
            '---',
            'name: literal-skill',
            'description: |',
            '  line one',
            '  line two',
            '---',
            'body',
        ].join('\n');
        const literalParsed = parseAndValidateSkill('literal-skill', literalRaw);
        expect(literalParsed.ok, 'literal description parses');
        if (literalParsed.ok) {
            expect(literalParsed.entry.description === 'line one\nline two', 'literal preserves newline');
        }
    })
);

cases.push(
    await runCase('load-time validation enforces name, description, body size, lines, C0 and wire markers', async () => {
        // Mismatched dirName vs name
        expect(!parseAndValidateSkill('other-name', '---\nname: real-name\ndescription: ok\n---\nbody').ok, 'rejects name mismatch');
        // Bad name format
        expect(!parseAndValidateSkill('Bad_Name', '---\nname: Bad_Name\ndescription: ok\n---\nbody').ok, 'rejects uppercase/underscore name');
        // Description length bounds (1..1024)
        expect(!parseAndValidateSkill('a', '---\nname: a\ndescription: ""\n---\nbody').ok, 'rejects empty description');
        const maxDesc = '字'.repeat(1024);
        expect(parseAndValidateSkill('a', `---\nname: a\ndescription: "${maxDesc}"\n---\nbody`).ok, 'accepts 1024-char description');
        const overDesc = '字'.repeat(1025);
        expect(!parseAndValidateSkill('a', `---\nname: a\ndescription: "${overDesc}"\n---\nbody`).ok, 'rejects 1025-char description');
        // Non-string metadata rejected
        expect(
            !parseAndValidateSkill('a', '---\nname: a\ndescription: ok\nmetadata:\n  bot.owner-only: true\n---\nbody').ok,
            'rejects unquoted boolean in metadata'
        );
        expect(
            !parseAndValidateSkill('a', '---\nname: a\ndescription: ok\nmetadata: "bad"\n---\nbody').ok,
            'rejects scalar metadata'
        );
        // Empty body rejected
        expect(!parseAndValidateSkill('a', '---\nname: a\ndescription: ok\n---\n   \n').ok, 'rejects empty body');
        // 24,000 code points boundary (using 2-byte UTF-16 emoji surrogate pairs to verify code-point counting)
        const maxEmojiBody = '😀'.repeat(SKILL_MAX_BODY_CHARS);
        expect(parseAndValidateSkill('a', `---\nname: a\ndescription: ok\n---\n${maxEmojiBody}`).ok, 'accepts 24,000 code points');
        const overEmojiBody = '😀'.repeat(SKILL_MAX_BODY_CHARS + 1);
        expect(!parseAndValidateSkill('a', `---\nname: a\ndescription: ok\n---\n${overEmojiBody}`).ok, 'rejects 24,001 code points');
        // 500 lines boundary
        const maxLinesBody = Array.from({ length: SKILL_MAX_BODY_LINES }, (_, idx) => `line ${idx + 1}`).join('\n');
        expect(parseAndValidateSkill('a', `---\nname: a\ndescription: ok\n---\n${maxLinesBody}`).ok, 'accepts 500 lines');
        const overLinesBody = Array.from({ length: SKILL_MAX_BODY_LINES + 1 }, (_, idx) => `line ${idx + 1}`).join('\n');
        expect(!parseAndValidateSkill('a', `---\nname: a\ndescription: ok\n---\n${overLinesBody}`).ok, 'rejects 501 lines');
        // C0 control characters rejected, \t and \n allowed
        expect(parseAndValidateSkill('a', '---\nname: a\ndescription: ok\n---\na\tb\nc').ok, 'allows tab and newline');
        expect(!parseAndValidateSkill('a', '---\nname: a\ndescription: ok\n---\nbad\u0007bell').ok, 'rejects C0 bell');
        expect(!parseAndValidateSkill('a', '---\nname: a\ndescription: ok\n---\nbad\u0000nul').ok, 'rejects C0 nul');
        // Bare or un-backticked wire markers rejected; backtick-wrapped and fenced allowed
        for (const marker of ['[工具轮次]', '[时间]', '<<EOF'] as const) {
            expect(!parseAndValidateSkill('a', `---\nname: a\ndescription: ok\n---\n${marker}`).ok, `rejects standalone ${marker}`);
            expect(!parseAndValidateSkill('a', `---\nname: a\ndescription: ok\n---\n注意不要写 ${marker} 标记`).ok, `rejects un-backticked inline ${marker}`);
            expect(parseAndValidateSkill('a', `---\nname: a\ndescription: ok\n---\n注意不要写 \`${marker}\` 标记`).ok, `allows inline backticked ${marker}`);
            expect(parseAndValidateSkill('a', `---\nname: a\ndescription: ok\n---\n\`\`\`\n${marker}\n\`\`\``).ok, `allows fenced code block ${marker}`);
        }
        // Unclosed code fence must not bypass wire marker check
        expect(!parseAndValidateSkill('a', '---\nname: a\ndescription: ok\n---\n```\n<<EOF').ok, 'unclosed fence still rejects <<EOF');
    })
);

cases.push(
    await runCase('directory loading skips bad skills with warn, caps at 20, and caches by dir', async () => {
        const dir = makeTempSkillsDir();
        writeSkillFile(dir, 'broken-skill', '---\nname: wrong-name\ndescription: bad\n---\nhi');
        for (let idx = 1; idx <= 22; idx += 1) {
            const name = `skill-${String(idx).padStart(2, '0')}`;
            writeSkillFile(dir, name, `---\nname: ${name}\ndescription: desc ${idx}\n---\nbody ${idx}`);
        }

        const { result: loaded, warnings } = withCapturedWarn(() => loadSkillsFromDirectory(dir));
        expect(loaded.length === SKILL_MAX_COUNT, `caps loaded skills at ${SKILL_MAX_COUNT}`);
        expect(loaded[0]?.name === 'skill-01', 'sorted order starts at skill-01');
        expect(loaded[19]?.name === 'skill-20', 'sorted order ends at skill-20');
        expect(warnings.some((line) => line.includes('broken-skill')), 'warns on broken skill');
        expect(warnings.some((line) => line.includes('skill-21')), 'warns when truncating past 20');

        const missing = loadSkillsFromDirectory(join(TEMP_ROOT, 'does-not-exist'));
        expect(missing.length === 0, 'missing directory returns empty array without throwing');

        const prevEnv = process.env.SKILLS_DIR;
        try {
            resetSkillRegistryCache();
            process.env.SKILLS_DIR = dir;
            const { result: viaEnv } = withCapturedWarn(() => getSkillRegistry());
            expect(viaEnv.length === SKILL_MAX_COUNT, 'getSkillRegistry reads SKILLS_DIR');
            expect(getSkillRegistry() === viaEnv, 'getSkillRegistry returns cached instance');
            resetSkillRegistryCache();
            const { result: reloaded } = withCapturedWarn(() => getSkillRegistry());
            expect(reloaded !== viaEnv, 'resetSkillRegistryCache forces reload');
        } finally {
            if (prevEnv === undefined) delete process.env.SKILLS_DIR;
            else process.env.SKILLS_DIR = prevEnv;
            resetSkillRegistryCache();
        }
    })
);

cases.push(
    await runCase('filterAvailableSkills enforces three-key gating, unknown flags fail closed, scope and ownerOnly', async () => {
        const skills: readonly SkillEntry[] = [
            makeDummySkill({ name: 'need-both', requiredTools: ['a', 'b'] }),
            makeDummySkill({ name: 'any-one', anyTools: ['x', 'y'] }),
            makeDummySkill({ name: 'need-html', requiredTools: ['send_widget'], requiredFlags: [WIDGET_ALLOW_HTML_FLAG] }),
            makeDummySkill({ name: 'unknown-flag', requiredFlags: ['future-unlisted-flag'] }),
            makeDummySkill({ name: 'group-only', scope: 'group' }),
            makeDummySkill({ name: 'private-only', scope: 'private' }),
            makeDummySkill({ name: 'owner-secret', ownerOnly: true }),
        ];

        const nonOwnerGroup = filterAvailableSkills({
            skills,
            declaredToolNames: new Set(['a', 'b', 'y', 'send_widget']),
            activeFlags: new Set(['future-unlisted-flag']),
            scope: 'group',
            isOwner: false,
        }).map((item) => item.name);

        expect(nonOwnerGroup.includes('need-both'), 'required-tools passes when all present');
        expect(nonOwnerGroup.includes('any-one'), 'any-tools passes when one present');
        expect(!nonOwnerGroup.includes('need-html'), 'widget-html hidden when widget-allow-html flag off');
        expect(!nonOwnerGroup.includes('unknown-flag'), 'unknown flag fails closed even if in activeFlags');
        expect(nonOwnerGroup.includes('group-only'), 'group skill visible in group');
        expect(!nonOwnerGroup.includes('private-only'), 'private skill hidden in group');
        expect(!nonOwnerGroup.includes('owner-secret'), 'ownerOnly hidden from non-owner');

        const ownerPrivateWithFlag = filterAvailableSkills({
            skills,
            declaredToolNames: new Set(['a', 'send_widget']),
            activeFlags: new Set([WIDGET_ALLOW_HTML_FLAG]),
            scope: 'private',
            isOwner: true,
        }).map((item) => item.name);

        expect(!ownerPrivateWithFlag.includes('need-both'), 'required-tools fails when one tool missing');
        expect(!ownerPrivateWithFlag.includes('any-one'), 'any-tools fails when none present');
        expect(ownerPrivateWithFlag.includes('need-html'), 'widget-html visible when flag on');
        expect(!ownerPrivateWithFlag.includes('group-only'), 'group skill hidden in private');
        expect(ownerPrivateWithFlag.includes('private-only'), 'private skill visible in private');
        expect(ownerPrivateWithFlag.includes('owner-secret'), 'ownerOnly visible to owner');
    })
);

cases.push(
    await runCase('skill catalog tail skips empty list, truncates descriptions at 120 chars and caps at 1,200 chars', async () => {
        expect(buildSkillCatalogSection([]) === null, 'empty skills builds null section');
        const untouched: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
        appendSkillCatalogTail(untouched, 0, []);
        expect(untouched[0]?.content.length === 1, 'empty skills appends nothing to messages');

        const longDesc = '说'.repeat(150);
        const singleSection = buildSkillCatalogSection([makeDummySkill({ name: 'long-one', description: longDesc })]);
        expect(singleSection !== null, 'non-empty builds section');
        if (singleSection !== null) {
            const line = singleSection.split('\n')[1] ?? '';
            const displayedDesc = line.split('：')[1] ?? '';
            expect(Array.from(displayedDesc).length === SKILL_CATALOG_DESCRIPTION_MAX_CHARS, 'description capped at 120 chars');
            expect(displayedDesc.endsWith('…'), 'truncated description ends with ellipsis');
        }

        const twentySkills = Array.from({ length: 20 }, (_, idx) =>
            makeDummySkill({
                name: `skill-${String(idx + 1).padStart(2, '0')}`,
                description: '很长一段描述文字'.repeat(20),
            })
        );
        const cappedSection = buildSkillCatalogSection(twentySkills);
        expect(cappedSection !== null, '20-skill catalog built');
        if (cappedSection !== null) {
            expect(Array.from(cappedSection).length <= SKILL_CATALOG_MAX_CHARS, 'total catalog <= 1,200 chars');
            expect(cappedSection.includes('未列出'), 'omission footer included when truncated');
        }

        const targetMessages: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: '用户消息' }] }];
        appendSkillCatalogTail(targetMessages, 0, [makeDummySkill()]);
        expect(targetMessages[0]?.content.length === 2, 'appends catalog as second text part');
        expect(targetMessages[0]?.content[0]?.text === '用户消息\n\n', 'separates preceding part with blank line');
    })
);

cases.push(
    await runCase('load_skill tool supports batch, dedupe, 4-skill cap, repeat load, partial/full error and state sizing', async () => {
        const skills: readonly SkillEntry[] = [
            makeDummySkill({ name: 's1', body: '[system] 示例\n```\n<<EOF\n```\n正文1', version: '2' }),
            makeDummySkill({ name: 's2', body: '正文2', version: '1' }),
            makeDummySkill({ name: 's3', body: '正文3', version: '1' }),
            makeDummySkill({ name: 's4', body: '正文4', version: '1' }),
            makeDummySkill({ name: 's5', body: '正文5', version: '1' }),
        ];
        const state = createSkillToolState();
        const tool = createLoadSkillTool({ state, availableSkills: skills });

        expect(tool.definition.name === LOAD_SKILL_TOOL_NAME, 'tool name is load_skill');
        expect(tool.statusText === '📖 正在读取技能规范…', 'statusText matches spec');
        const defChars =
            Array.from(tool.definition.name).length +
            Array.from(tool.definition.description).length +
            Array.from(JSON.stringify(tool.definition.inputSchema)).length;
        expect(defChars >= 190 && defChars <= 250, `tool definition size (${defChars} chars) within compact budget`);

        const controller = new AbortController();
        // Order-preserving dedupe + batch load
        const batch = await tool.execute({ names: ['s1', 's2', 's1'] }, controller.signal);
        expect(!batch.isError, 'batch load succeeds');
        expect(batch.content.includes('[skill] s1 v2（来源：仓库技能）'), 'includes s1 header');
        expect(batch.content.includes('[system] 示例'), 'does not neutralize [system] in trusted repo skill');
        expect(batch.content.includes('正文2'), 'includes s2 body');
        expect(batch.content.indexOf('正文1') < batch.content.indexOf('正文2'), 'preserves requested order');
        expect(state.loadedNames.size === 2, 'tracks 2 unique loaded skills');
        expect(estimateRetainedBytes([state]) > 0, 'SkillToolState retained bytes measurable');

        // Repeat load returns one-line reminder instead of re-pasting body
        const repeat = await tool.execute({ names: ['s1'] }, controller.signal);
        expect(!repeat.isError, 'repeat load is not an error');
        expect(repeat.content.includes('本次回复已加载过 `s1` v2'), 'repeat load returns reminder');
        expect(!repeat.content.includes('正文1'), 'repeat load does not re-paste body');

        // Partial valid + partial invalid
        const partial = await tool.execute({ names: ['s3', 'nonexistent'] }, controller.signal);
        expect(!partial.isError, 'partial valid returns isError: false');
        expect(partial.content.includes('正文3'), 'partial valid loads s3');
        expect(partial.content.includes('`nonexistent` 不可用'), 'partial valid annotates invalid item');
        expect(state.loadedNames.size === 3, 's3 added to loadedNames');

        // All invalid
        const allMissing = await tool.execute({ names: ['nope-1', 'nope-2'] }, controller.signal);
        expect(allMissing.isError, 'all invalid returns isError: true');
        expect(allMissing.content.includes('没有名为'), 'all invalid explains missing names');

        // Reaching 4-skill cap (4th succeeds, 5th rejected)
        const hitCap = await tool.execute({ names: ['s4', 's5'] }, controller.signal);
        expect(!hitCap.isError, '4th skill succeeds while 5th hits cap');
        expect(hitCap.content.includes('正文4'), 's4 loaded');
        expect(hitCap.content.includes('已达上限'), 's5 notes cap');
        expect(state.loadedNames.size === 4, 'loadedNames at cap 4');

        // Pure 5th after cap reached
        const overCap = await tool.execute({ names: ['s5'] }, controller.signal);
        expect(overCap.isError, 'new skill after cap returns isError: true');

        // Repeat load still works at cap 4
        const repeatAtCap = await tool.execute({ names: ['s2'] }, controller.signal);
        expect(!repeatAtCap.isError, 'repeat load still works at cap 4');

        // Invalid input shapes
        expect((await tool.execute({ names: [] }, controller.signal)).isError, 'empty array fails');
        expect((await tool.execute({ names: ['BadName'] }, controller.signal)).isError, 'invalid name format fails');
    })
);

cases.push(
    await runCase('repository skills/* are all valid, version-aligned and work end-to-end', async () => {
        resetSkillRegistryCache();
        const prevEnv = process.env.SKILLS_DIR;
        delete process.env.SKILLS_DIR;
        try {
            const { result: repoSkills, warnings } = withCapturedWarn(() => getSkillRegistry());
            expect(warnings.length === 0, `no warnings loading repo skills (got: ${warnings.join('; ')})`);

            const names = repoSkills.map((item) => item.name);
            expect(
                names.join(',') === 'harness-reporting,widget-a2ui,widget-html,workspace-usage',
                `exact 4 repo skills loaded (got: ${names.join(',')})`
            );

            const byName = new Map(repoSkills.map((item) => [item.name, item]));
            const a2ui = byName.get('widget-a2ui');
            const html = byName.get('widget-html');
            const workspace = byName.get('workspace-usage');
            const harness = byName.get('harness-reporting');

            expect(a2ui !== undefined && html !== undefined && workspace !== undefined && harness !== undefined, 'all 4 skills present');
            if (!a2ui || !html || !workspace || !harness) return;

            expect(a2ui.version === String(WIDGET_GUIDE_VERSION), `widget-a2ui version matches WIDGET_GUIDE_VERSION (${WIDGET_GUIDE_VERSION})`);
            expect(html.version === String(WIDGET_GUIDE_VERSION), `widget-html version matches WIDGET_GUIDE_VERSION (${WIDGET_GUIDE_VERSION})`);
            expect(a2ui.requiredTools.join(',') === 'send_widget', 'widget-a2ui requires send_widget');
            expect(a2ui.requiredFlags.length === 0, 'widget-a2ui has no requiredFlags');
            expect(html.requiredTools.join(',') === 'send_widget', 'widget-html requires send_widget');
            expect(html.requiredFlags.join(',') === WIDGET_ALLOW_HTML_FLAG, 'widget-html requires widget-allow-html');
            expect(workspace.requiredTools.join(',') === 'workspace', 'workspace-usage requires workspace');
            expect(harness.requiredTools.join(',') === 'harness_issue', 'harness-reporting requires harness_issue');

            // Neither widget guide references deprecated get_ui_guide or workspace_preview
            expect(!a2ui.body.includes('get_ui_guide') && !a2ui.body.includes('workspace_preview'), 'widget-a2ui migrated references');
            expect(!html.body.includes('get_ui_guide') && !html.body.includes('workspace_preview'), 'widget-html migrated references');
            expect(html.body.includes('workspace(action="write" / "edit" / "list")'), 'widget-html updated workspace syntax');

            // A2UI JSON examples in widget-a2ui still compile cleanly
            const jsonBlocks = [...a2ui.body.matchAll(/```json\n(\{.*?\})\n```/gs)]
                .map((match) => match[1] ?? '')
                .filter((block) => block.includes('"components"'));
            expect(jsonBlocks.length >= 2, 'widget-a2ui has at least 2 full surface JSON examples');
            for (const block of jsonBlocks) {
                const compiled = compileA2uiSurface(block);
                expect(compiled.ok, `widget-a2ui example compiles (${compiled.ok ? 'ok' : compiled.code})`);
                if (compiled.ok) expect(compiled.size.zlibBytes <= 4096, 'compiled example fits 4096 B zlib9');
            }

            // Catalog renders all 4 skills well within 1,200 chars and loads all 4 in one call
            const catalog = buildSkillCatalogSection(repoSkills);
            expect(catalog !== null && Array.from(catalog).length <= SKILL_CATALOG_MAX_CHARS, '4-skill catalog within budget');
            const tool = createLoadSkillTool({ state: createSkillToolState(), availableSkills: repoSkills });
            const loadedAll = await tool.execute({ names: [...names] }, new AbortController().signal);
            expect(!loadedAll.isError, 'load_skill loads all 4 built-in skills in one batch');

            // Tool overrides includes 'skills'
            expect(TOOL_GROUP_KEYS.includes('skills'), "TOOL_GROUP_KEYS includes 'skills'");
        } finally {
            if (prevEnv !== undefined) process.env.SKILLS_DIR = prevEnv;
            resetSkillRegistryCache();
        }
    })
);

reportResults(cases);
