/**
 * `probe:thinking` CLI: the one-off thinking-effort probe.
 *
 * Safe by default: prints the matrix and writes the plan under
 * tmp/thinking-probe/<date>/ and sends nothing. A real run needs `--yes`, the
 * test instance (TEST_INSTANCE=1) and DB_PATH pointing at database.test.sqlite;
 * `--stub` rehearses the whole pipeline in-process for zero cost.
 *
 * It never starts the bot, never touches Telegram and never opens the database.
 * Credentials come from the process env or `.env.test` only — never `.env`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRunGates, loadProbeEnvironment, type ProbeEnvironment } from './effort-env.mts';
import { createProbeLanes, type ProbeLane } from './effort-lanes.mts';
import { buildProbePlan, clampBudget, defaultBudget, parseModelsJson, resolveModelSpecs } from './effort-plan.mts';
import { acceptedEffortsFromDocument, validateProbeDocument } from './effort-results.mts';
import { runProbe } from './effort-run.mts';
import { createStubFetch, stubLaneConfigurations } from './effort-stub.mts';
import {
    HARD_MAX_REQUESTS,
    HARD_MAX_USD,
    MAX_W2_OUTPUT_TOKEN_CAP,
    MIN_W2_OUTPUT_TOKEN_CAP,
    W2_OUTPUT_TOKEN_CAP,
    isValidW2OutputTokenCap,
    type EffortValue,
    type ProbeBudget,
    type ProbeModelSpec,
    type ProbePlatform,
    type ProbeWave,
} from './effort-types.mts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT_ROOT = join(REPOSITORY_ROOT, 'tmp', 'thinking-probe');
const MAX_IMPORT_BYTES = 1_048_576;

export const HELP = `思考档位 probe（一次性；默认 dry-run，不发请求）

  npx tsx scripts/probe/thinking-effort.mts                    # dry-run 计划
  npx tsx scripts/probe/thinking-effort.mts --wave w1 --yes    # 真实发送（需门禁）

选项：
  --dry-run            只生成计划（默认）
  --yes                真实发送请求（需 --yes；--stub 时不需要）
  --stub               零网络排练：进程内 stub 跑完整流程（W0，0 元）
  --wave <w1|w2|all>   W1=接受性矩阵（默认全跑），W2=效果抽样
  --models <a,b>       只跑这些模型
  --models-json <f>    用导出的 catalog 快照替换内置模型清单
  --from-results <f>   W2 单独运行：从已有 results.json 读 acceptedEfforts
  --max-requests <n>   请求数上限（硬上限 ${HARD_MAX_REQUESTS}，默认 w1=120/w2=60/all=${HARD_MAX_REQUESTS}）
  --max-usd <n>        金额上限（硬上限 $${HARD_MAX_USD}，默认 $3）
  --w2-cap <tokens>    W2 输出上限（默认 ${W2_OUTPUT_TOKEN_CAP}，范围 ${MIN_W2_OUTPUT_TOKEN_CAP}..${MAX_W2_OUTPUT_TOKEN_CAP}）
                       这是 probe 自己的预算护栏，生产不设该上限；
                       4096 覆盖常见样本，6144/8192 更少截断但成本增加
  --timeout-ms <n>     单请求超时（默认 W1 90000；W2/all 150000）
  --max-retries <n>    传输类错误重试次数（默认 1）
  --concurrency 1      只支持串行（并发 1）
  --out <dir>          输出目录（只允许 tmp/thinking-probe/ 之下）
  --check <f>          校验一份 results.json（/probe import 之前）
  --help

真实运行（在 k-on-bot-test 容器内，owner 授权后）：
  docker compose --profile test run --rm --no-deps k-on-bot-test \\
    sh -lc 'npx tsx scripts/probe/thinking-effort.mts --wave all --yes'
`;

export interface CliOptions {
    wave: ProbeWave | 'all';
    yes: boolean;
    stub: boolean;
    models: readonly string[] | undefined;
    modelsJson: string | undefined;
    fromResults: string | undefined;
    maxRequests: number | undefined;
    maxUsd: number | undefined;
    w2Cap: number | undefined;
    timeoutMs: number | undefined;
    maxRetries: number | undefined;
    concurrency: number;
    out: string | undefined;
    check: string | undefined;
    help: boolean;
}

class CliError extends Error {}

const parseNumber = (name: string, raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new CliError(`${name} 需要一个正数，收到 ${raw}`);
    return value;
};

const parseWave = (raw: string): ProbeWave | 'all' => {
    if (raw === 'w1' || raw === 'w2' || raw === 'all') return raw;
    throw new CliError(`--wave 只接受 w1|w2|all，收到 ${raw}`);
};

export const parseArguments = (argv: readonly string[]): CliOptions => {
    const options: CliOptions = {
        wave: 'all',
        yes: false,
        stub: false,
        models: undefined,
        modelsJson: undefined,
        fromResults: undefined,
        maxRequests: undefined,
        maxUsd: undefined,
        w2Cap: undefined,
        timeoutMs: undefined,
        maxRetries: undefined,
        concurrency: 1,
        out: undefined,
        check: undefined,
        help: false,
    };
    let wave: ProbeWave | 'all' = 'all';
    let maxRequests: number | undefined;
    let maxUsd: number | undefined;
    let w2Cap: number | undefined;
    let timeoutMs: number | undefined;
    let maxRetries: number | undefined;
    let models: readonly string[] | undefined;
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
                wave = parseWave(valueOf('--wave'));
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
            case '--from-results':
                options.fromResults = valueOf('--from-results');
                break;
            case '--max-requests':
                maxRequests = parseNumber('--max-requests', valueOf('--max-requests'));
                break;
            case '--max-usd':
                maxUsd = parseNumber('--max-usd', valueOf('--max-usd'));
                break;
            case '--w2-cap': {
                const raw = valueOf('--w2-cap');
                const value = Number(raw);
                if (!isValidW2OutputTokenCap(value)) {
                    throw new CliError(
                        `--w2-cap 需要 ${MIN_W2_OUTPUT_TOKEN_CAP}..${MAX_W2_OUTPUT_TOKEN_CAP} 之间的整数 token 数，收到 ${raw}`
                    );
                }
                w2Cap = value;
                break;
            }
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
            default:
                throw new CliError(`未知参数 ${argument}；用 --help 查看用法`);
        }
    }
    if (options.concurrency !== 1) throw new CliError(`只支持 --concurrency 1（收到 ${options.concurrency}）`);
    if (options.fromResults !== undefined && wave !== 'w2') {
        throw new CliError('--from-results 只能配合 --wave w2 使用（W1 才能产生 acceptedEfforts）');
    }
    return {
        ...options,
        wave,
        ...(models === undefined ? {} : { models }),
        ...(maxRequests === undefined ? {} : { maxRequests }),
        ...(maxUsd === undefined ? {} : { maxUsd }),
        ...(w2Cap === undefined ? {} : { w2Cap }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(maxRetries === undefined ? {} : { maxRetries }),
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
    const base = defaultBudget(options.wave);
    return clampBudget({
        maxRequests: options.maxRequests ?? base.maxRequests,
        maxUsd: options.maxUsd ?? base.maxUsd,
        timeoutMs: options.timeoutMs ?? base.timeoutMs,
        maxRetries: options.maxRetries ?? base.maxRetries,
        ...(options.w2Cap === undefined ? {} : { w2OutputTokenCap: options.w2Cap }),
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

const loadAcceptedEfforts = (options: CliOptions): Record<string, readonly EffortValue[]> => {
    if (options.fromResults === undefined) return {};
    const parsed = readJsonFile(options.fromResults);
    const validation = validateProbeDocument(parsed);
    if (!validation.valid || validation.document === null) {
        throw new CliError(`--from-results 文件不符合 §7 schema：${validation.errors.slice(0, 5).join('; ')}`);
    }
    return acceptedEffortsFromDocument(validation.document);
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
        console.error(`✗ 不符合 §7 schema（${validation.errors.length} 处）：`);
        for (const problem of validation.errors.slice(0, 20)) console.error(`  - ${problem}`);
        return 1;
    }
    console.log(`✓ 符合 §7 schema：${validation.document.results.length} 个模型`);
    for (const entry of validation.document.results) {
        console.log(
            `  ${entry.model}: accepted=[${entry.acceptedEfforts.join(',')}] default=${entry.defaultEffort ?? 'null'} toggle=${entry.toggle ? 'yes' : 'no'} errors=${Object.keys(entry.errorSummary).length}`
        );
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

    const environment = loadProbeEnvironment();
    const lanes = lanesOf(environment, options.stub);
    const gates = evaluateRunGates(environment).gates;
    let specs: readonly ProbeModelSpec[] | undefined;
    let acceptedEffortsByModel: Record<string, readonly EffortValue[]> = {};
    try {
        const loaded = loadModelSpecs(options);
        specs = loaded.specs;
        for (const problem of loaded.problems) console.warn(`[models-json] ${problem}`);
        acceptedEffortsByModel = loadAcceptedEfforts(options);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
    }

    const budget = budgetOf(options);
    const dryRun = options.stub ? false : !options.yes;
    console.log(`[probe] mode: ${options.stub ? 'stub (W0, zero network)' : dryRun ? 'dry-run (no request)' : 'LIVE'}`);
    if (options.wave !== 'w1') {
        console.log(
            `[budget] W2 输出上限 ${budget.w2OutputTokenCap ?? W2_OUTPUT_TOKEN_CAP} tokens（probe 预算护栏，生产不设该上限；默认 ${W2_OUTPUT_TOKEN_CAP}）`
        );
    }
    console.log(`[probe] 该脚本不启动 bot、不碰 Telegram、不读写数据库；只写 tmp/thinking-probe/`);
    printGates(environment);

    const plan = buildProbePlan({
        wave: options.wave,
        budget,
        ...(options.models === undefined ? {} : { models: options.models }),
        ...(specs === undefined ? {} : { modelSpecs: specs }),
        ...(Object.keys(acceptedEffortsByModel).length === 0 ? {} : { acceptedEffortsByModel }),
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
            wave: options.wave,
            budget,
            ...(options.models === undefined ? {} : { models: options.models }),
            ...(specs === undefined ? {} : { modelSpecs: specs }),
            ...(Object.keys(acceptedEffortsByModel).length === 0 ? {} : { acceptedEffortsByModel }),
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
