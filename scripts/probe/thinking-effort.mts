/**
 * `probe:thinking` CLI: the thinking-effort probe (v2, §3.6).
 *
 * Safe by default: prints the matrix and writes the plan under
 * tmp/thinking-probe/<date>/ and sends nothing. A real run needs `--yes`, the
 * test instance (TEST_INSTANCE=1) and DB_PATH pointing at database.test.sqlite;
 * `--stub` rehearses the whole pipeline in-process for zero cost.
 *
 * It never starts the bot, never touches Telegram and never opens the database.
 * Credentials come from the process env or `.env.test` only — never `.env`.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRunGates, loadProbeEnvironment, type ProbeEnvironment } from './effort-env.mts';
import { createProbeLanes, type ProbeLane } from './effort-lanes.mts';
import { buildProbePlan, clampBudget, defaultBudget, parseModelsJson, resolveModelSpecs } from './effort-plan.mts';
import { mergeProbeDocuments, validateProbeDocument } from './effort-results.mts';
import { runProbe } from './effort-run.mts';
import { createStubFetch, stubLaneConfigurations } from './effort-stub.mts';
import {
    HARD_MAX_REQUESTS,
    HARD_MAX_USD,
    type ProbeBudget,
    type ProbeModelSpec,
    type ProbePlatform,
    type ProbeResultDocument,
} from './effort-types.mts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT_ROOT = join(REPOSITORY_ROOT, 'tmp', 'thinking-probe');
const MAX_IMPORT_BYTES = 1_048_576;

export const HELP = `思考档位 probe（v2；默认 dry-run，不发请求）

  npx tsx scripts/probe/thinking-effort.mts                    # dry-run 计划
  npx tsx scripts/probe/thinking-effort.mts --yes              # 真实发送（需门禁）
  npx tsx scripts/probe/thinking-effort.mts --merge a.json,b.json  # 合并多份 results.json

选项：
  --dry-run            只生成计划（默认）
  --yes                真实发送请求（需 --yes；--stub 时不需要）
  --stub               零网络排练：进程内 stub 跑完整流程（W0，0 元）
  --wave <w1>          仅保留 W1 接受性矩阵（v2 已移除 W2）
  --models <a,b>       只跑这些模型
  --models-json <f>    用 /probe export 导出的 catalog 快照替换内置模型清单
  --max-requests <n>   请求数上限（硬上限 ${HARD_MAX_REQUESTS}，默认 ${HARD_MAX_REQUESTS}）
  --max-usd <n>        金额上限（硬上限 $${HARD_MAX_USD}，默认 $3）
  --timeout-ms <n>     单请求超时（默认 90000）
  --max-retries <n>    传输类错误重试次数（默认 1）
  --concurrency 1      只支持串行（并发 1）
  --out <dir>          输出目录（只允许 tmp/thinking-probe/ 之下）
  --check <f>          校验一份 results.json（支持 v1/v2，/probe import 之前）
  --merge <f1,f2,...>  合并多份 results.json 为一份 v2（可逗号分隔或重复传入）
  --help

真实运行（在 k-on-bot-test 容器内，owner 授权后）：
  docker compose --profile test run --rm --no-deps k-on-bot-test \\
    sh -lc 'npx tsx scripts/probe/thinking-effort.mts --yes'
`;

export interface CliOptions {
    wave: 'w1';
    yes: boolean;
    stub: boolean;
    models: readonly string[] | undefined;
    modelsJson: string | undefined;
    maxRequests: number | undefined;
    maxUsd: number | undefined;
    timeoutMs: number | undefined;
    maxRetries: number | undefined;
    concurrency: number;
    out: string | undefined;
    check: string | undefined;
    merge: readonly string[] | undefined;
    help: boolean;
}

class CliError extends Error {}

const parseNumber = (name: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new CliError(`${name} 需要一个正数，收到 ${raw}`);
    return value;
};

const parseWave = (raw: string): 'w1' => {
    if (raw === 'w1') return 'w1';
    throw new CliError(`--wave w2/all 已在 v2 移除（仅运行 W1 接受性矩阵），收到 ${raw}`);
};

export const parseArguments = (argv: readonly string[]): CliOptions => {
    const options: CliOptions = {
        wave: 'w1',
        yes: false,
        stub: false,
        models: undefined,
        modelsJson: undefined,
        maxRequests: undefined,
        maxUsd: undefined,
        timeoutMs: undefined,
        maxRetries: undefined,
        concurrency: 1,
        out: undefined,
        check: undefined,
        merge: undefined,
        help: false,
    };
    let maxRequests: number | undefined;
    let maxUsd: number | undefined;
    let timeoutMs: number | undefined;
    let maxRetries: number | undefined;
    let models: readonly string[] | undefined;
    const mergeFiles: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === undefined) continue;
        const [flag, inlineValue] = argument.includes('=') ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)] : [argument, undefined];
        const valueOf = (name: string): string => {
            if (inlineValue !== undefined) return inlineValue;
            const next = argv[index + 1];
            if (next === undefined) throw new CliError(`${name} 需要一个值`);
            index += 1;
            return next;
        };
        switch (flag) {
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--dry-run':
                options.yes = false;
                break;
            case '--yes':
                options.yes = true;
                break;
            case '--stub':
                options.stub = true;
                break;
            case '--wave':
                options.wave = parseWave(valueOf('--wave'));
                break;
            case '--models': {
                const list = valueOf('--models')
                    .split(',')
                    .map((model) => model.trim())
                    .filter((model) => model !== '');
                if (list.length === 0) throw new CliError('--models 需要一个非空列表');
                models = list;
                break;
            }
            case '--models-json':
                options.modelsJson = valueOf('--models-json');
                break;
            case '--max-requests':
                maxRequests = parseNumber('--max-requests', valueOf('--max-requests'));
                break;
            case '--max-usd':
                maxUsd = parseNumber('--max-usd', valueOf('--max-usd'));
                break;
            case '--timeout-ms':
                timeoutMs = parseNumber('--timeout-ms', valueOf('--timeout-ms'));
                break;
            case '--max-retries':
                maxRetries = Math.trunc(parseNumber('--max-retries', valueOf('--max-retries')));
                break;
            case '--concurrency':
                options.concurrency = Math.trunc(parseNumber('--concurrency', valueOf('--concurrency')));
                break;
            case '--out':
                options.out = valueOf('--out');
                break;
            case '--check':
                options.check = valueOf('--check');
                break;
            case '--merge': {
                const parts = valueOf('--merge')
                    .split(',')
                    .map((item) => item.trim())
                    .filter((item) => item !== '');
                if (parts.length === 0) throw new CliError('--merge 需要至少一个文件路径');
                mergeFiles.push(...parts);
                break;
            }
            default:
                throw new CliError(`未知参数 ${argument}；用 --help 查看用法`);
        }
    }
    if (options.concurrency !== 1) throw new CliError(`只支持 --concurrency 1（收到 ${options.concurrency}）`);
    return {
        ...options,
        ...(models === undefined ? {} : { models }),
        ...(maxRequests === undefined ? {} : { maxRequests }),
        ...(maxUsd === undefined ? {} : { maxUsd }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(maxRetries === undefined ? {} : { maxRetries }),
        ...(mergeFiles.length === 0 ? {} : { merge: mergeFiles }),
    };
};

const readJsonFile = (path: string): unknown => {
    if (!existsSync(path)) throw new CliError(`文件不存在：${path}`);
    const text = readFileSync(path, 'utf8');
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new CliError(`不是合法 JSON：${path}（${error instanceof Error ? error.message : String(error)}）`);
    }
};

const datePathOf = (now: Date): string => {
    const date = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    const time = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}`;
    return join(OUTPUT_ROOT, date, time);
};

/** Only tmp/thinking-probe/ may receive files; anything else is refused */
const resolveOutputDirectory = (requested: string | undefined, now: Date): string => {
    const candidate = requested === undefined ? datePathOf(now) : resolve(requested);
    const relativePath = relative(OUTPUT_ROOT, candidate);
    if (relativePath === '' || relativePath.startsWith('..') || resolve(OUTPUT_ROOT, relativePath) !== candidate) {
        throw new CliError(`输出目录必须在 ${OUTPUT_ROOT} 之下（收到 ${candidate}）`);
    }
    return candidate;
};

const lanesOf = (environment: ProbeEnvironment, stub: boolean): Readonly<Record<ProbePlatform, ProbeLane>> =>
    stub
        ? createProbeLanes(environment, { fetch: createStubFetch(), lanes: stubLaneConfigurations() })
        : createProbeLanes(environment);

const lanesUsedBy = (plan: { readonly models: readonly ProbeModelSpec[] }): ProbePlatform[] => {
    const platforms = new Set<ProbePlatform>();
    for (const model of plan.models) platforms.add(model.platform);
    return [...platforms];
};

const printGates = (environment: ProbeEnvironment): void => {
    const gates = evaluateRunGates(environment);
    for (const gate of gates.gates) console.log(`[gate] ${gate.ok ? 'ok  ' : 'FAIL'} ${gate.name} (${gate.detail})`);
    if (environment.usedEnvFile) {
        console.log(`[env] 从 ${environment.envFilePath ?? '.env.test'} 补了 ${environment.filledKeys} 个键（进程环境优先；绝不读 .env）`);
    }
    for (const warning of environment.warnings) console.log(`[env] ${warning}`);
};

const budgetOf = (options: CliOptions): ProbeBudget => {
    const base = defaultBudget();
    return clampBudget({
        maxRequests: options.maxRequests ?? base.maxRequests,
        maxUsd: options.maxUsd ?? base.maxUsd,
        timeoutMs: options.timeoutMs ?? base.timeoutMs,
        maxRetries: options.maxRetries ?? base.maxRetries,
    });
};

const loadModelSpecs = (options: CliOptions): { readonly specs: readonly ProbeModelSpec[] | undefined; readonly problems: readonly string[] } => {
    if (options.modelsJson === undefined) {
        return { specs: undefined, problems: [] };
    }
    const parsed = parseModelsJson(readJsonFile(options.modelsJson));
    const selected = resolveModelSpecs(parsed, options.models);
    return {
        specs: selected,
        problems: parsed.problems.map((problem) => (problem.index < 0 ? problem.message : `#${problem.index}: ${problem.message}`)),
    };
};

const checkResultsFile = (path: string): number => {
    if (!existsSync(path)) {
        console.error(`文件不存在：${path}`);
        return 1;
    }
    const size = statSync(path).size;
    if (size > MAX_IMPORT_BYTES) {
        console.error(`文件 ${size} 字节，超过 /probe import 的 1 MB 上限`);
        return 1;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        console.error(`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
    const validation = validateProbeDocument(parsed);
    if (!validation.valid || validation.document === null) {
        console.error(`✗ 不符合 probe schema（${validation.errors.length} 处）：`);
        for (const problem of validation.errors.slice(0, 20)) console.error(`  - ${problem}`);
        return 1;
    }
    const doc = validation.document;
    console.log(`✓ 符合 probe schema v${doc.schema}：${doc.results.length} 个模型`);
    if (doc.schema === 2) {
        for (const entry of doc.results) {
            const toggleText = entry.toggle === null ? 'n/a' : entry.toggle ? 'yes' : 'no';
            const toolsText = entry.tools === null ? 'n/a' : entry.tools.supported ? 'ok' : 'fail';
            console.log(
                `  ${entry.model} (${entry.platform}/${entry.lane}): accepted=[${entry.acceptedEfforts.join(',')}] mapped=[${entry.mappedEfforts.join(',')}] toggle=${toggleText} tools=${toolsText} errors=${Object.keys(entry.errorSummary).length}`
            );
        }
    } else {
        for (const entry of doc.results) {
            console.log(
                `  ${entry.model}: accepted=[${entry.acceptedEfforts.join(',')}] default=${entry.defaultEffort ?? 'null'} toggle=${entry.toggle ? 'yes' : 'no'} errors=${Object.keys(entry.errorSummary).length}`
            );
        }
    }
    return 0;
};

const mergeResultsFiles = (paths: readonly string[], requestedOut: string | undefined): number => {
    const documents: ProbeResultDocument[] = [];
    for (const path of paths) {
        if (!existsSync(path)) {
            console.error(`文件不存在：${path}`);
            return 1;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(path, 'utf8'));
        } catch (error) {
            console.error(`不是合法 JSON（${path}）：${error instanceof Error ? error.message : String(error)}`);
            return 1;
        }
        const validation = validateProbeDocument(parsed);
        if (!validation.valid || validation.document === null) {
            console.error(`✗ ${path} 不符合 probe schema（${validation.errors.length} 处）：`);
            for (const problem of validation.errors.slice(0, 10)) console.error(`  - ${problem}`);
            return 1;
        }
        documents.push(validation.document);
    }
    const merged = mergeProbeDocuments(documents);
    const outDir = resolveOutputDirectory(requestedOut, new Date());
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, 'results.json');
    const json = JSON.stringify(merged.document, null, 2);
    writeFileSync(outPath, json);
    console.log(
        `[merge] 合并 ${merged.sourceCount} 份结果 → ${merged.document.results.length} 个模型（覆盖更新：${merged.replacedModels.join(', ') || '无'}）`
    );
    console.log(`[merge] out: ${outPath}`);
    if (Buffer.byteLength(json, 'utf8') > MAX_IMPORT_BYTES) {
        console.warn(`[merge] 警告：输出超过 1 MB 上限，可能无法直接通过 /probe import`);
    }
    return 0;
};

const main = async (): Promise<number> => {
    let options: CliOptions;
    try {
        options = parseArguments(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        console.error('\n' + HELP);
        return 2;
    }
    if (options.help) {
        console.log(HELP);
        return 0;
    }
    if (options.check !== undefined) {
        return checkResultsFile(options.check);
    }
    if (options.merge !== undefined) {
        try {
            return mergeResultsFiles(options.merge, options.out);
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            return 2;
        }
    }

    const environment = loadProbeEnvironment();
    const lanes = lanesOf(environment, options.stub);
    const gates = evaluateRunGates(environment).gates;
    let specs: readonly ProbeModelSpec[] | undefined;
    try {
        const loaded = loadModelSpecs(options);
        specs = loaded.specs;
        for (const problem of loaded.problems) console.warn(`[models-json] ${problem}`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
    }

    const budget = budgetOf(options);
    const dryRun = options.stub ? false : !options.yes;
    console.log(`[probe] mode: ${options.stub ? 'stub (W0, zero network)' : dryRun ? 'dry-run (no request)' : 'LIVE'}`);
    if (options.modelsJson === undefined) {
        console.log('[probe] matrix: built-in snapshot (use --models-json from /probe export to probe the active DB menu)');
    }
    console.log(`[probe] 该脚本不启动 bot、不碰 Telegram、不读写数据库；只写 tmp/thinking-probe/`);
    printGates(environment);

    const plan = buildProbePlan({
        budget,
        ...(options.models === undefined ? {} : { models: options.models }),
        ...(specs === undefined ? {} : { modelSpecs: specs }),
    });
    const usedPlatforms = lanesUsedBy(plan);
    for (const platform of usedPlatforms) {
        const lane = lanes[platform];
        console.log(`[lane] ${platform.padEnd(9)} ${lane.configuration.laneId}${lane.ready ? '' : ` NOT READY: ${lane.configuration.problems.join('; ')}`}`);
    }
    const notReady = usedPlatforms.filter((platform) => !lanes[platform].ready);
    if (notReady.length > 0 && !dryRun) {
        console.error(`[probe] 拒绝发送：lane 未配置 ${notReady.join(', ')}`);
        return 1;
    }
    const failedGates = evaluateRunGates(environment);
    if (!dryRun && !options.stub && !failedGates.ok) {
        console.error(`[probe] 拒绝真实发送：门禁未通过（${failedGates.reasons.join(', ')}）`);
        console.error('  真实运行必须在 k-on-bot-test 容器内（TEST_INSTANCE=1 且 DB_PATH=database.test.sqlite）。');
        console.error("  只想零成本排练请用 --stub；只查看计划请用 --dry-run。");
        return 1;
    }
    if (options.stub && !dryRun) {
        console.log('[probe] stub 模式：请求打到进程内 stub，不会产生任何网络流量与费用');
    }

    let outDir: string;
    try {
        outDir = resolveOutputDirectory(options.out, new Date());
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
    }

    const controller = new AbortController();
    const onInterrupt = (): void => {
        if (controller.signal.aborted) {
            console.error('[probe] 再次中断，立即退出');
            process.exit(130);
        }
        controller.abort();
        console.error('[probe] 收到中断，正在结束当前请求并写结果（再按一次立即退出）');
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);

    try {
        const outcome = await runProbe({
            budget,
            ...(options.models === undefined ? {} : { models: options.models }),
            ...(specs === undefined ? {} : { modelSpecs: specs }),
            dryRun,
            stub: options.stub,
            lanes,
            environment,
            outDir,
            gates,
            signal: controller.signal,
            pacingMs: options.stub || dryRun ? null : { min: 1_500, max: 3_000 },
        });
        console.log('');
        console.log(`[probe] out: ${outDir}`);
        if (outcome.document !== null) {
            const models = outcome.document.results.map((entry) => entry.model);
            console.log(`[probe] results.json 覆盖 ${models.length} 个模型：${models.join(', ') || '（空）'}`);
            console.log('[probe] 下一步：把 results.json 发给 bot 私聊并回复 /probe import 生成能力提案');
        }
        return 0;
    } catch (error) {
        console.error(`[probe] 失败：${error instanceof Error ? error.message : String(error)}`);
        return 1;
    } finally {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onInterrupt);
    }
};

// Importing this module (the offline fixtures do) must not run the CLI
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = await main();
