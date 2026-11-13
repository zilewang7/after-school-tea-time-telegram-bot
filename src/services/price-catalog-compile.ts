/**
 * The compiler and differ of the price watcher (pricing design 2026-1113-1150
 * §5.2): turns the downloaded catalogs into `PriceCandidate` rows, then
 * compares those with the rows the database has in force and returns the
 * `ProposalDraft`s the owner approves from a private chat.
 *
 * Sources and precedence:
 * - models.dev provider TOMLs are the baseline (base prices, cache prices,
 *   service-tier multipliers, scheduled `date.gte` changes);
 * - the official Vertex pricing page overrides them for the Gemini family; it
 *   is also the only source of the Priority PayGo rows and the promo windows;
 * - ephone fills models with no price at all (the relay-only image id);
 * - LiteLLM is cross-checked and can only add warnings.
 *
 * Everything here is pure: no network, no clock (the run's `now` is passed in),
 * no database. A broken document becomes a warning, never an exception, so one
 * changed page cannot cost the owner the whole run.
 *
 * Candidate dates: the price in force today is proposed with
 * `effectiveFrom = now` (the run instant, minute precision) — never a
 * historical date — and a scheduled change keeps its exact boundary. The
 * differ therefore compares prices, not row identities: rows the owner already
 * approved stay untouched.
 */
import { parse as parseToml } from 'smol-toml';
import type { PriceEntry, PriceTier } from '../config/model-pricing.js';
import {
    confidenceOf,
    PRICE_DRIFT_TOLERANCE,
    sourceOf,
    SOURCE_PRIORITY,
    type CatalogFetchResult,
    type CatalogModelRef,
    type CatalogSourceKind,
    type CompileOptions,
    type CompileResult,
    type PriceCandidate,
    type ProposalDraft,
} from './price-catalog-types.js';
import {
    CATALOG_MODEL_REFS,
    EPHONE_PRICING_URL,
    LITELLM_PRICING_URL,
    modelsDevTomlUrl,
    VERTEX_PRICING_URL,
} from './price-catalog-fetch.js';

/** Open-ended start of the raw windows the sources describe (history is the DB's job) */
const BEGINNING = new Date('1970-01-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** A window ending within this horizon gets an expiry reminder */
const EXPIRY_HORIZON_MS = 7 * DAY_MS;
/** Reject implausible jumps instead of proposing them (design risk #1) */
const MAX_PRICE_GROWTH = 10;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** The candidate start of "the price in force today": one instant per run */
const runFrom = (now: Date): Date => new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);

const otherTier = (tier: PriceTier): PriceTier => (tier === 'standard' ? 'priority' : 'standard');

/** `1.5` → `1.50`, `0.075` → `0.075`: enough digits for a token price */
const formatPrice = (value: number): string =>
    Number.isInteger(value) ? value.toFixed(2) : String(Number(value.toFixed(4)));

// ---------------------------------------------------------------------------
// Generic TOML helpers
// ---------------------------------------------------------------------------

type TomlNode = Readonly<Record<string, unknown>>;

const isNode = (value: unknown): value is TomlNode =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const nodeOf = (value: unknown): TomlNode | null => (isNode(value) ? value : null);

const numberOf = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return Number(value);
    return null;
};

const stringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const nodesOf = (value: unknown): readonly TomlNode[] => (Array.isArray(value) ? value.filter(isNode) : []);

/** The first `key` reachable through tables and arrays under `value` */
const findNested = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findNested(item, key);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    const node = nodeOf(value);
    if (node === null) return undefined;
    if (key in node) return node[key];
    for (const child of Object.values(node)) {
        const found = findNested(child, key);
        if (found !== undefined) return found;
    }
    return undefined;
};

/** Every condition key of a `when` clause, flattened (not/all/any included) */
const conditionKeysOf = (when: unknown, keys: string[]): void => {
    const node = nodeOf(when);
    if (node === null) return;
    for (const [key, value] of Object.entries(node)) {
        if (key === 'not' || key === 'any' || key === 'all') {
            conditionKeysOf(value, keys);
            continue;
        }
        keys.push(key);
    }
};

// ---------------------------------------------------------------------------
// Price values and multipliers
// ---------------------------------------------------------------------------

/** The price channels of one row, as the catalogs express them */
interface ChannelValues {
    readonly input: number;
    readonly cached: number;
    readonly output: number;
    readonly cacheWrite: number | null;
    readonly imageOutput: number | null;
}

/** A multiplier resolved per channel; 1 = unchanged */
interface TextFactor {
    readonly input: number;
    readonly cached: number;
    readonly output: number;
    readonly imageOutput: number;
}

const NO_FACTOR: TextFactor = { input: 1, cached: 1, output: 1, imageOutput: 1 };

const factorProduct = (first: TextFactor, second: TextFactor): TextFactor => ({
    input: first.input * second.input,
    cached: first.cached * second.cached,
    output: first.output * second.output,
    imageOutput: first.imageOutput * second.imageOutput,
});

const scaleValues = (values: ChannelValues, factor: TextFactor): ChannelValues => ({
    input: values.input * factor.input,
    cached: values.cached * factor.cached,
    output: values.output * factor.output,
    cacheWrite: values.cacheWrite === null ? null : values.cacheWrite * factor.input,
    imageOutput: values.imageOutput === null ? null : values.imageOutput * factor.imageOutput,
});

const plainFactor = (value: number): TextFactor => ({
    input: value,
    cached: value,
    output: value,
    imageOutput: value,
});

/** A node in a factor tree is either a number or `{ price }` */
const nodeFactor = (node: unknown): number | null => numberOf(node) ?? (isNode(node) ? numberOf(node.price) : null);

/**
 * models.dev writes multipliers in three shapes: a plain number (deepseek
 * `factor = 2`), `{ text = 2 }` (OpenAI/xAI) and
 * `{ text = { input = { price = 1.8, cache = { read = 1.8 } }, output = 1.8 }, image = 1.8 }`
 * (Vertex, image models). Missing channels mean "not scaled".
 */
const resolveTextFactor = (factor: unknown): TextFactor => {
    const plain = numberOf(factor);
    if (plain !== null) return plainFactor(plain);
    const node = nodeOf(factor);
    if (node === null) return NO_FACTOR;
    const text = node.text;
    const textNumber = numberOf(text);
    const image = numberOf(node.image) ?? 1;
    if (textNumber !== null) return { input: textNumber, cached: textNumber, output: textNumber, imageOutput: image };
    const textNode = nodeOf(text);
    if (textNode === null) return { ...NO_FACTOR, imageOutput: image };
    const inputNode = nodeOf(textNode.input);
    const input = inputNode === null ? 1 : nodeFactor(inputNode) ?? 1;
    const cacheNode = inputNode === null ? null : nodeOf(inputNode.cache);
    const cached =
        cacheNode === null
            ? input
            : numberOf(cacheNode.read) ?? 1;
    const output = nodeFactor(textNode.output) ?? 1;
    const imageOutput = nodeFactor(textNode.image) ?? image;
    return { input, cached, output, imageOutput };
};

/** One raw window: what `from` costs once this factor is applied */
interface RawWindow {
    readonly from: Date;
    readonly to: Date | undefined;
    readonly factor: TextFactor;
}

/** A window with concrete prices (already scaled) */
interface WindowedValues {
    readonly from: Date;
    readonly to: Date | undefined;
    readonly values: ChannelValues;
}

/**
 * The dates a candidate may carry: only the price in force today (retimed to
 * the run instant) and scheduled windows in the future. Windows that ended
 * before the run are history and never become candidates.
 */
const windowedPrices = (
    windows: readonly WindowedValues[],
    now: Date,
    from: Date
): readonly { readonly from: Date; readonly to: Date | undefined; readonly values: ChannelValues }[] => {
    const sorted = [...windows].sort((first, second) => first.from.getTime() - second.from.getTime());
    const nextFutureStart = (startIndex: number): Date | undefined => {
        for (let index = startIndex + 1; index < sorted.length; index += 1) {
            const window = sorted[index];
            if (window !== undefined && window.from.getTime() > now.getTime()) return window.from;
        }
        return undefined;
    };
    let activeIndex = -1;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
        const window = sorted[index];
        if (window === undefined) continue;
        const inForce = window.from.getTime() <= now.getTime();
        const stillOpen = window.to === undefined || window.to.getTime() > now.getTime();
        if (inForce && stillOpen) {
            activeIndex = index;
            break;
        }
    }
    const result: { from: Date; to: Date | undefined; values: ChannelValues }[] = [];
    const appendFuture = (startIndex: number): void => {
        for (let index = startIndex; index < sorted.length; index += 1) {
            const window = sorted[index];
            if (window === undefined || window.from.getTime() <= now.getTime()) continue;
            result.push({ from: window.from, to: nextFutureStart(index) ?? window.to, values: window.values });
        }
    };
    const active = sorted[activeIndex];
    if (active === undefined) {
        // Nothing covers the run instant (a promo gap): only future windows
        appendFuture(0);
        return result;
    }
    result.push({ from, to: nextFutureStart(activeIndex) ?? active.to, values: active.values });
    appendFuture(activeIndex + 1);
    return result;
};

// ---------------------------------------------------------------------------
// models.dev TOML
// ---------------------------------------------------------------------------

/** What one TOML says about one model, before the run instant is applied */
interface ParsedTomlPrice {
    readonly standard: readonly WindowedValues[];
    readonly priority: readonly WindowedValues[];
}

interface MultiplierClass {
    readonly kind: 'priority' | 'date' | 'schedule' | 'ignored';
    readonly label: string;
    readonly date: string | null;
}

const classifyWhen = (when: unknown): MultiplierClass => {
    const keys: string[] = [];
    conditionKeysOf(when, keys);
    const serviceTierNode = nodeOf(findNested(when, 'service_tier'));
    const serviceTier = serviceTierNode === null ? null : stringOf(serviceTierNode.equals);
    if (serviceTier !== null) {
        if (serviceTier === 'priority') return { kind: 'priority', label: 'service_tier=priority', date: null };
        // flex/fast/batch are different service tiers we never request
        return { kind: 'ignored', label: `service_tier=${serviceTier}`, date: null };
    }
    const dateNode = nodeOf(findNested(when, 'date'));
    const date = dateNode === null ? null : stringOf(dateNode.gte);
    if (date !== null) return { kind: 'date', label: `date>=${date}`, date };
    if (keys.includes('utc_days') || keys.includes('utc_hours') || keys.includes('holiday')) {
        return { kind: 'schedule', label: '峰谷时段', date: null };
    }
    if (keys.includes('region')) return { kind: 'ignored', label: '区域乘数', date: null };
    if (keys.includes('context')) return { kind: 'ignored', label: '长上下文分档', date: null };
    return { kind: 'ignored', label: keys.length === 0 ? '未知条件' : keys.join('+'), date: null };
};

/** `YYYY-MM-DD` → UTC midnight; null for anything else */
const utcDayOf = (day: string): Date | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const date = new Date(`${day}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
};

/** models.dev `cache.write`: a number, or a TTL map of which we take 5m / the only one */
const cacheWriteOf = (cache: TomlNode | null, model: string, warnings: string[]): number | null => {
    if (cache === null) return null;
    const write = cache.write;
    const plain = numberOf(write);
    if (plain !== null) return plain;
    const writeNode = nodeOf(write);
    if (writeNode === null) return null;
    const fiveMinute = numberOf(writeNode['5m']);
    if (fiveMinute !== null) return fiveMinute;
    const ttlEntries = Object.entries(writeNode).filter(([, value]) => numberOf(value) !== null);
    const only = ttlEntries.length === 1 ? ttlEntries[0] : undefined;
    if (only !== undefined) return numberOf(only[1]);
    if (ttlEntries.length > 1) {
        const ttls = ttlEntries.map(([ttl]) => ttl).join('、');
        warnings.push(`${model}：models.dev 缓存写入有多个 TTL（${ttls}）且无 5m，未取缓存写入价`);
    }
    return null;
};

/** Base prices of one TOML's `[cost.text.input]` / `[cost.text.output]` / `[cost.image.output]` */
const baseValuesOf = (cost: TomlNode, model: string, warnings: string[]): ChannelValues | null => {
    const text = nodeOf(cost.text);
    const inputNode = text === null ? null : nodeOf(text.input);
    const outputNode = text === null ? null : nodeOf(text.output);
    const input = inputNode === null ? null : numberOf(inputNode.price);
    const output = outputNode === null ? null : numberOf(outputNode.price);
    if (input === null || output === null) {
        warnings.push(`${model}：models.dev TOML 缺输入或输出价，跳过该模型`);
        return null;
    }
    const cacheNode = inputNode === null ? null : nodeOf(inputNode.cache);
    const cached = (cacheNode === null ? null : numberOf(cacheNode.read)) ?? input;
    const imageNode = nodeOf(cost.image);
    const imageOutputNode = imageNode === null ? null : nodeOf(imageNode.output);
    const imageOutput = imageOutputNode === null ? null : numberOf(imageOutputNode.price);
    return {
        input,
        cached,
        output,
        cacheWrite: cacheWriteOf(cacheNode, model, warnings),
        imageOutput,
    };
};

/** Ordered boundaries from `date.gte` multipliers: each later window keeps the earlier factors */
const dateWindowsOf = (
    dates: readonly { readonly from: Date; readonly factor: TextFactor }[]
): readonly RawWindow[] => {
    const sorted = [...dates].sort((first, second) => first.from.getTime() - second.from.getTime());
    const boundaries = new Map<number, { readonly from: Date; readonly factor: TextFactor }>();
    let cumulative = NO_FACTOR;
    for (const date of sorted) {
        cumulative = factorProduct(cumulative, date.factor);
        boundaries.set(date.from.getTime(), { from: date.from, factor: cumulative });
    }
    const ordered = [...boundaries.values()].sort((first, second) => first.from.getTime() - second.from.getTime());
    const windows: RawWindow[] = [{ from: BEGINNING, to: ordered[0]?.from, factor: NO_FACTOR }];
    ordered.forEach((boundary, index) => {
        windows.push({ from: boundary.from, to: ordered[index + 1]?.from, factor: boundary.factor });
    });
    return windows;
};

/**
 * Reads one model's provider TOML. Returns null when the model has no usable
 * baseline price; unmodelled dimensions are reported as warnings, never guessed.
 */
const parseTomlPrice = (body: string, model: string, warnings: string[]): ParsedTomlPrice | null => {
    let parsed: unknown;
    try {
        parsed = parseToml(body);
    } catch (error) {
        warnings.push(`${model}：models.dev TOML 解析失败（${error instanceof Error ? error.message : String(error)}）`);
        return null;
    }
    const root = nodeOf(parsed);
    if (root === null) {
        warnings.push(`${model}：models.dev TOML 不是一个对象，跳过`);
        return null;
    }
    const schema = numberOf(root.schema);
    if (schema !== 2) warnings.push(`${model}：models.dev TOML 的 schema 是 ${String(schema)}（期望 2），仍按 schema 2 解析`);
    const cost = nodeOf(root.cost);
    if (cost === null) {
        warnings.push(`${model}：models.dev TOML 没有 [cost] 段，跳过该模型`);
        return null;
    }
    const values = baseValuesOf(cost, model, warnings);
    if (values === null) return null;

    const priorityFactors: TextFactor[] = [];
    const dateFactors: { readonly from: Date; readonly factor: TextFactor }[] = [];
    const scheduleFactors: TextFactor[] = [];
    const ignored = new Set<string>();
    const text = nodeOf(cost.text);
    const inputNode = text === null ? null : nodeOf(text.input);
    const outputNode = text === null ? null : nodeOf(text.output);
    const multipliers = [...nodesOf(cost.multipliers)];
    const overrides = [...(inputNode === null ? [] : nodesOf(inputNode.overrides)), ...(outputNode === null ? [] : nodesOf(outputNode.overrides))];
    for (const override of overrides) {
        const classified = classifyWhen(override.when);
        ignored.add(classified.kind === 'ignored' ? classified.label : '长上下文分档');
    }
    for (const multiplier of multipliers) {
        const classified = classifyWhen(multiplier.when);
        const factor = resolveTextFactor(multiplier.factor);
        if (classified.kind === 'priority') {
            priorityFactors.push(factor);
            continue;
        }
        if (classified.kind === 'date') {
            const from = classified.date === null ? null : utcDayOf(classified.date);
            if (from === null) {
                ignored.add(classified.label);
                continue;
            }
            dateFactors.push({ from, factor });
            continue;
        }
        if (classified.kind === 'schedule') {
            scheduleFactors.push(factor);
            continue;
        }
        ignored.add(classified.label);
    }
    if (ignored.size > 0) {
        warnings.push(`${model}：忽略未建模的 models.dev 字段（${[...ignored].join('、')}）`);
    }
    if (scheduleFactors.length > 0) {
        // The base price is the off-peak rate; our table estimates at the peak
        // rate, so comparing the two would read as a permanent -50% drift.
        warnings.push(`${model}：models.dev 的峰谷乘数未建模（基价是谷时价），本次不生成该模型的目录价`);
        return null;
    }
    if (priorityFactors.length > 1) {
        warnings.push(`${model}：models.dev 有多个 priority 乘数，只取第一个`);
    }
    const priorityFactor = priorityFactors[0];
    const rawWindows = dateWindowsOf(dateFactors);
    const standard = rawWindows.map((window) => ({ from: window.from, to: window.to, values: scaleValues(values, window.factor) }));
    const priority =
        priorityFactor === undefined
            ? []
            : rawWindows.map((window) => ({
                  from: window.from,
                  to: window.to,
                  values: scaleValues(scaleValues(values, window.factor), priorityFactor),
              }));
    return { standard, priority };
};

// ---------------------------------------------------------------------------
// Official Vertex pricing page
// ---------------------------------------------------------------------------

/** The Gemini models the official page is authoritative for */
interface OfficialModelRef {
    readonly model: string;
    /** Lowercased prefix of the row label, e.g. "gemini 4 argon* through november 30, 2026" */
    readonly label: string;
    /** Labels of sibling models that must not match the prefix (3.8 Flash Cyber) */
    readonly exclude: RegExp | null;
}

const OFFICIAL_MODEL_REFS: readonly OfficialModelRef[] = [
    { model: 'gemini-4-hydrogen', label: 'gemini 4 hydrogen', exclude: null },
    { model: 'gemini-4-argon', label: 'gemini 4 argon', exclude: null },
    { model: 'gemini-4-carbon', label: 'gemini 4 carbon', exclude: null },
    { model: 'gemini-3.8-flash', label: 'gemini 3.8 flash', exclude: /gemini 3\.8 flash cyber/ },
    { model: 'gemini-nano-banana-2.1', label: 'gemini nano banana 2.1', exclude: null },
];

const OFFICIAL_MODEL_IDS: ReadonlySet<string> = new Set(OFFICIAL_MODEL_REFS.map((ref) => ref.model));

const MONTHS: Readonly<Record<string, number>> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
};

const DATE_RANGE_LABEL = /(through|starting)\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i;

/** The validity window a row label states ("through Nov 30" / "starting Dec 1") */
const windowOfLabel = (label: string): { readonly from: Date; readonly to: Date | undefined } => {
    const match = DATE_RANGE_LABEL.exec(label);
    if (match === null) return { from: BEGINNING, to: undefined };
    const action = (match[1] ?? '').toLowerCase();
    const month = MONTHS[(match[2] ?? '').toLowerCase()];
    const day = Number.parseInt(match[3] ?? '', 10);
    const year = Number.parseInt(match[4] ?? '', 10);
    if (month === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return { from: BEGINNING, to: undefined };
    const midnight = Date.UTC(year, month, day);
    // "through Nov 30" stays valid until the end of that day, exclusive 12-01
    if (action === 'through') return { from: BEGINNING, to: new Date(midnight + DAY_MS) };
    return { from: new Date(midnight), to: undefined };
};

const decodeEntities = (text: string): string =>
    text
        .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'");

/** Visible text of one HTML fragment */
const htmlText = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

interface HtmlRow {
    readonly header: boolean;
    readonly cells: readonly string[];
}

interface HtmlTable {
    readonly index: number;
    readonly rows: readonly HtmlRow[];
}

const collectTables = (html: string): readonly HtmlTable[] => {
    const tables: HtmlTable[] = [];
    const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
    for (const tableMatch of html.matchAll(tablePattern)) {
        const tableHtml = tableMatch[1];
        const index = tableMatch.index;
        if (tableHtml === undefined || index === undefined) continue;
        const rows: HtmlRow[] = [];
        for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
            const rowHtml = rowMatch[1];
            if (rowHtml === undefined) continue;
            const cells: string[] = [];
            let header = false;
            for (const cellMatch of rowHtml.matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)) {
                if ((cellMatch[1] ?? '').toLowerCase() === 'h') header = true;
                cells.push(htmlText(cellMatch[2] ?? ''));
            }
            if (cells.length > 0) rows.push({ header, cells });
        }
        tables.push({ index, rows });
    }
    return tables;
};

/** Which tab a table belongs to: Standard Model, Priority, or a tier we do not model */
const tierOfTable = (html: string, tableIndex: number): PriceTier | null => {
    const before = html.slice(0, tableIndex);
    const panelStart = before.lastIndexOf('role="tabpanel"');
    if (panelStart === -1) return null;
    const panelOpening = html.slice(panelStart, Math.min(panelStart + 800, tableIndex));
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(panelOpening);
    const tabId = labelledBy === null ? null : labelledBy[1];
    if (tabId === null || tabId === undefined) return null;
    const buttonIndex = before.indexOf(`id="${tabId}"`);
    if (buttonIndex === -1) return null;
    const openingStart = before.lastIndexOf('<button', buttonIndex);
    const openingEnd = before.indexOf('>', buttonIndex);
    const openingTag = openingStart === -1 ? '' : before.slice(openingStart, openingEnd === -1 ? buttonIndex + 600 : openingEnd + 1);
    const eventDetail = /track-metadata-eventdetail="([^"]*)"/.exec(openingTag);
    const closingEnd = before.indexOf('</button>', buttonIndex);
    const buttonText = htmlText(before.slice(buttonIndex, closingEnd === -1 ? buttonIndex + 400 : closingEnd));
    const label = (eventDetail === null ? buttonText : (eventDetail[1] ?? '')).toLowerCase();
    if (label.includes('standard')) return 'standard';
    // "Priority Flex/Batch" style tabs are not our tier
    if (label.includes('priority') && !label.includes('flex')) return 'priority';
    return null;
};

/** Header-driven column lookup, so a column being added/renamed fails loudly instead of shifting prices */
interface TableColumns {
    readonly model: number;
    readonly type: number;
    readonly region: number | null;
    readonly price: number;
    readonly cacheRead: number | null;
}

const columnsOf = (header: readonly string[]): TableColumns | null => {
    let model = -1;
    let type = -1;
    let region: number | null = null;
    let price = -1;
    let cacheRead: number | null = null;
    let cacheReadOnly: number | null = null;
    header.forEach((cell, index) => {
        const label = cell.toLowerCase();
        if (label === 'model') model = index;
        else if (label === 'type') type = index;
        else if (label === 'region') region = index;
        else if (label.includes('cache')) {
            // The first cache column is the one for short prompts; a table with
            // a long-context split repeats it for >200K (the second column)
            if (label.includes('read') && cacheRead === null) cacheRead = index;
            if (cacheReadOnly === null) cacheReadOnly = index;
        } else if (label.includes('price') && price === -1) price = index;
    });
    if (model === -1 || type === -1 || price === -1) return null;
    return { model, type, region, price, cacheRead: cacheRead ?? cacheReadOnly };
};

const cellAt = (row: HtmlRow, index: number | null): string => {
    if (index === null) return '';
    return row.cells[index] ?? '';
};

/** `$1.50` → 1.5; N/A and footnoted dashes → null */
const usdOf = (text: string): number | null => {
    const match = /(-?[\d,]+(?:\.\d+)?)/.exec(text.replace(/<[^>]*>/g, ''));
    if (match === null) return null;
    const value = Number((match[1] ?? '').replace(/,/g, ''));
    return Number.isFinite(value) ? value : null;
};

const officialModelOf = (label: string): string | null => {
    const normalized = label.toLowerCase().replace(/\s+/g, ' ').trim();
    const ref = OFFICIAL_MODEL_REFS.find(
        (candidate) => normalized.startsWith(candidate.label) && (candidate.exclude === null || !candidate.exclude.test(normalized))
    );
    return ref?.model ?? null;
};

interface OfficialPrice {
    readonly model: string;
    readonly tier: PriceTier;
    readonly from: Date;
    readonly to: Date | undefined;
    readonly values: ChannelValues;
}

interface AccumulatedRow {
    input: number | null;
    cached: number | null;
    output: number | null;
    imageOutput: number | null;
}

const rowKeyOf = (model: string, tier: PriceTier, window: { readonly from: Date; readonly to: Date | undefined }): string =>
    `${model}|${tier}|${window.from.getTime()}|${window.to === undefined ? 'open' : window.to.getTime()}`;

/**
 * Parses the official page's three tab groups into Gemini rows. The parser is
 * strict about structure: a table it cannot attribute to Standard/Priority is
 * skipped (batch/flex tabs, feature tables), and a missing header column makes
 * the table unusable rather than silently shifting prices.
 */
const parseVertexPricing = (html: string): { readonly prices: readonly OfficialPrice[]; readonly warnings: readonly string[] } => {
    const warnings: string[] = [];
    const tables = collectTables(html);
    if (tables.length === 0) {
        return { prices: [], warnings: ['官方 Vertex 页没有解析到表格，页面结构可能已变更'] };
    }
    const accumulated = new Map<string, { readonly model: string; readonly tier: PriceTier; readonly window: { readonly from: Date; readonly to: Date | undefined }; readonly row: AccumulatedRow }>();
    for (const table of tables) {
        const tier = tierOfTable(html, table.index);
        if (tier === null) continue;
        const headerRow = table.rows.find((row) => row.header);
        if (headerRow === undefined) continue;
        const columns = columnsOf(headerRow.cells);
        if (columns === null) {
            warnings.push('官方 Vertex 页有价格表缺少 Model/Type/Price 列，结构可能已变更');
            continue;
        }
        let currentModel: string | null = null;
        let currentWindow: { readonly from: Date; readonly to: Date | undefined } = { from: BEGINNING, to: undefined };
        let currentRegion = '';
        for (const row of table.rows) {
            if (row.header) continue;
            const label = cellAt(row, columns.model);
            if (label !== '') {
                currentModel = officialModelOf(label);
                currentWindow = windowOfLabel(label);
            }
            if (currentModel === null) continue;
            const region = cellAt(row, columns.region);
            if (region !== '') currentRegion = region.toLowerCase();
            // Non-global endpoints cost 10% more; our routes use global only
            if (currentRegion.includes('non-global')) continue;
            const type = cellAt(row, columns.type).toLowerCase();
            if (type === '') continue;
            const price = usdOf(cellAt(row, columns.price));
            if (price === null) continue;
            const cacheRead = columns.cacheRead === null ? null : usdOf(cellAt(row, columns.cacheRead));
            const key = rowKeyOf(currentModel, tier, currentWindow);
            const existing = accumulated.get(key);
            const rowValues: AccumulatedRow = existing?.row ?? { input: null, cached: null, output: null, imageOutput: null };
            if (type.includes('image output')) rowValues.imageOutput = price;
            else if (type.includes('input') && !type.includes('output')) {
                rowValues.input = price;
                if (cacheRead !== null) rowValues.cached = cacheRead;
            } else if (type.includes('output') && type.includes('text')) rowValues.output = price;
            accumulated.set(key, { model: currentModel, tier, window: currentWindow, row: rowValues });
        }
    }
    const prices: OfficialPrice[] = [];
    for (const { model, tier, window, row } of accumulated.values()) {
        const missing = [row.input === null ? 'input' : null, row.cached === null ? 'cached' : null, row.output === null ? 'output' : null].filter(
            (field) => field !== null
        );
        if (missing.length > 0) {
            warnings.push(`官方 Vertex 页（${model} / ${tier}）缺 ${missing.join('、')} 价，跳过该行`);
            continue;
        }
        if (row.input === null || row.cached === null || row.output === null) continue;
        prices.push({
            model,
            tier,
            from: window.from,
            to: window.to,
            values: {
                input: row.input,
                cached: row.cached,
                output: row.output,
                cacheWrite: null,
                imageOutput: tier === 'standard' ? row.imageOutput : null,
            },
        });
    }
    if (prices.length === 0) warnings.push('官方 Vertex 页没有解析到任何 Gemini 价格，页面结构可能已变更');
    return { prices, warnings };
};

// ---------------------------------------------------------------------------
// ephone / LiteLLM
// ---------------------------------------------------------------------------

/** One ephone catalog row, in the units the relay states (no conversion) */
interface EphonePrice {
    readonly currency: string;
    readonly input: number | null;
    readonly cached: number | null;
    readonly output: number | null;
    readonly perImageUsd: number | null;
}

const parseEphoneCatalog = (json: string, warnings: string[]): ReadonlyMap<string, EphonePrice> => {
    const prices = new Map<string, EphonePrice>();
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error) {
        warnings.push(`ephone 定价 JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`);
        return prices;
    }
    const root = nodeOf(parsed);
    const data = root === null ? null : nodeOf(root.data);
    const models = data === null ? [] : Array.isArray(data.model_info) ? data.model_info : [];
    for (const model of models) {
        const node = nodeOf(model);
        if (node === null) continue;
        const name = stringOf(node.model_name);
        if (name === null) continue;
        const priceConfig = nodeOf(node.price_config);
        const originalPrice = priceConfig === null ? null : nodeOf(priceConfig.original_price);
        const conditions = originalPrice === null ? [] : Array.isArray(originalPrice.conditions) ? originalPrice.conditions : [];
        const price = nodeOf(nodeOf(conditions[0])?.price);
        if (price === null) continue;
        const currency = stringOf(price.currency) ?? '';
        const perImageUsd = stringOf(price.quota_type) === 'call' ? numberOf(price.model_price) : null;
        prices.set(name, {
            currency,
            input: numberOf(price.input_token_price),
            cached: numberOf(price.cache_read_token_price),
            output: numberOf(price.output_token_price),
            perImageUsd,
        });
    }
    return prices;
};

/** The per-token cost fields LiteLLM uses for the two tiers we model */
interface LitellmCost {
    readonly input: number | null;
    readonly cached: number | null;
    readonly output: number | null;
    readonly imageOutput: number | null;
}

const parseLitellmCatalog = (json: string, warnings: string[]): ReadonlyMap<string, Readonly<Record<string, unknown>>> => {
    const entries = new Map<string, Readonly<Record<string, unknown>>>();
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error) {
        warnings.push(`LiteLLM 价目表解析失败（${error instanceof Error ? error.message : String(error)}）`);
        return entries;
    }
    const root = nodeOf(parsed);
    if (root === null) return entries;
    for (const [key, value] of Object.entries(root)) {
        const node = nodeOf(value);
        if (node !== null) entries.set(key, node);
    }
    return entries;
};

/** LiteLLM stores USD per token; our entries are per 1M tokens */
const LITELLM_PER_MILLION = 1_000_000;

const litellmCostOf = (node: Readonly<Record<string, unknown>>, tier: PriceTier, imageModel: boolean): LitellmCost => {
    const suffix = tier === 'priority' ? '_priority' : '';
    const perMillion = (field: string): number | null => {
        const value = numberOf(node[field]);
        return value === null ? null : value * LITELLM_PER_MILLION;
    };
    return {
        input: perMillion(`input_cost_per_token${suffix}`),
        cached: perMillion(`cache_read_input_token_cost${suffix}`),
        output: perMillion(`output_cost_per_token${suffix}`),
        imageOutput: imageModel ? perMillion(`output_cost_per_image_token${suffix}`) : null,
    };
};

/** Explicit LiteLLM keys: several of our ids only exist with a provider prefix there */
const LITELLM_KEYS: Readonly<Record<string, string>> = {
    'gpt-6-luna': 'gpt-6-luna',
    'gpt-6-sol': 'gpt-6-sol',
    'gpt-6-astra': 'gpt-6-astra',
    'claude-sonnet-5': 'claude-sonnet-5',
    'claude-sonnet-5-5': 'claude-sonnet-5-5',
    'claude-opus-5-5': 'claude-opus-5-5',
    'gemini-4-hydrogen': 'vertex_ai/gemini-4-hydrogen',
    'gemini-3.8-flash': 'vertex_ai/gemini-3.8-flash',
    'gemini-4-argon': 'vertex_ai/gemini-4-argon',
    'gemini-4-carbon': 'vertex_ai/gemini-4-carbon',
    'gemini-nano-banana-2.1': 'vertex_ai/gemini-nano-banana-2.1',
    'deepseek-flash': 'deepseek-flash',
    'grok-4.7': 'xai/grok-4.7',
    'grok-4.20-multi-agent-0309': 'xai/grok-4.20-multi-agent-0309',
    'mimo-v2.6-flash': 'xiaomi_mimo/mimo-v2.6-flash',
    'mimo-v2.6-pro': 'xiaomi_mimo/mimo-v2.6-pro',
};

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

const PRICE_FIELDS = ['inputPerM', 'cachedInputPerM', 'cacheWritePerM', 'outputPerM', 'imageOutputPerM', 'perImageUsd'] as const;

/** Relative difference above the contract's tolerance (0.5%) */
const samePrice = (first: number, second: number): boolean =>
    first === second ||
    Math.abs(first - second) <= PRICE_DRIFT_TOLERANCE * Math.max(Math.abs(first), Math.abs(second));

/** Field names as the owner reads them */
const PRICE_FIELD_LABELS: Readonly<Record<(typeof PRICE_FIELDS)[number], string>> = {
    inputPerM: '输入',
    cachedInputPerM: '缓存读',
    cacheWritePerM: '缓存写',
    outputPerM: '输出',
    imageOutputPerM: '图片输出',
    perImageUsd: '按张',
};

/** Only fields both sides state are compared: a local overlay is not a drift */
const priceDifferences = (baseline: PriceEntry, candidate: PriceEntry): readonly string[] => {
    const differences: string[] = [];
    for (const field of PRICE_FIELDS) {
        const baseValue = baseline[field];
        const candidateValue = candidate[field];
        if (baseValue === undefined || candidateValue === undefined) continue;
        if (!samePrice(baseValue, candidateValue)) {
            differences.push(`${PRICE_FIELD_LABELS[field]} ${formatPrice(baseValue)} → ${formatPrice(candidateValue)}`);
        }
    }
    return differences;
};

/** One-line reading of a row for the approval message */
const priceSummary = (entry: PriceEntry): string => {
    const parts = [`${formatPrice(entry.inputPerM)}/${formatPrice(entry.cachedInputPerM)}/${formatPrice(entry.outputPerM)}`];
    if (entry.cacheWritePerM !== undefined) parts.push(`写入 ${formatPrice(entry.cacheWritePerM)}`);
    if (entry.imageOutputPerM !== undefined) parts.push(`图片 ${formatPrice(entry.imageOutputPerM)}`);
    if (entry.perImageUsd !== undefined) parts.push(`按张 $${formatPrice(entry.perImageUsd)}`);
    return parts.join(' ');
};

/** The row in force for one (model, tier) at an instant, or null */
const entryInForceAt = (rows: readonly PriceEntry[], model: string, tier: PriceTier, at: Date): PriceEntry | null => {
    const instant = at.getTime();
    let found: PriceEntry | null = null;
    for (const row of rows) {
        if (row.model !== model || row.tier !== tier) continue;
        if (row.effectiveFrom.getTime() > instant) continue;
        if (row.effectiveTo !== undefined && row.effectiveTo.getTime() <= instant) continue;
        if (found === null || row.effectiveFrom.getTime() > found.effectiveFrom.getTime()) found = row;
    }
    return found;
};

const exactRowAt = (rows: readonly PriceEntry[], model: string, tier: PriceTier, from: Date): PriceEntry | null => {
    const instant = from.getTime();
    return rows.find((row) => row.model === model && row.tier === tier && row.effectiveFrom.getTime() === instant) ?? null;
};

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

interface TaggedPrice {
    readonly model: string;
    readonly tier: PriceTier;
    readonly from: Date;
    readonly to: Date | undefined;
    readonly values: ChannelValues;
    /** Per-image USD, only for image rows that carry no usage (ephone call billing) */
    readonly perImageUsd: number | null;
    readonly sourceKind: CatalogSourceKind;
}

const SOURCE_LABELS: Readonly<Record<CatalogSourceKind, string>> = {
    'models-dev': 'models.dev TOML',
    official: 'Vertex 官方页',
    ephone: 'ephone /api/pricing',
    litellm: 'LiteLLM',
};

/** The URL a candidate row records as its provenance */
const sourceUrlOf = (kind: CatalogSourceKind, ref: CatalogModelRef): string => {
    if (kind === 'official') return VERTEX_PRICING_URL;
    if (kind === 'ephone') return EPHONE_PRICING_URL;
    if (kind === 'litellm') return LITELLM_PRICING_URL;
    return modelsDevTomlUrl(ref);
};

const entryOfCandidate = (
    ref: CatalogModelRef,
    tier: PriceTier,
    from: Date,
    to: Date | undefined,
    values: ChannelValues,
    perImageUsd: number | null,
    sourceKind: CatalogSourceKind,
    checkedOn: string,
    note: string
): PriceEntry => {
    const keepExtras = tier === 'standard';
    return {
        model: ref.model,
        tier,
        inputPerM: values.input,
        cachedInputPerM: values.cached,
        outputPerM: values.output,
        ...(keepExtras && values.cacheWrite !== null ? { cacheWritePerM: values.cacheWrite } : {}),
        ...(keepExtras && values.imageOutput !== null ? { imageOutputPerM: values.imageOutput } : {}),
        ...(keepExtras && perImageUsd !== null ? { perImageUsd } : {}),
        effectiveFrom: from,
        ...(to === undefined ? {} : { effectiveTo: to }),
        source: sourceOf(sourceKind),
        sourceUrl: sourceUrlOf(sourceKind, ref),
        checkedOn,
        confidence: confidenceOf(sourceKind),
        note,
    };
};

/**
 * The tiers our requests can actually be served at. Only the Gemini platform
 * asks for Vertex's priority tier (the round's trafficType decides the price);
 * OpenAI/xAI priority would never be billed, so those rows are not compiled.
 */
const tiersOf = (model: string): readonly PriceTier[] =>
    model.toLowerCase().startsWith('gemini') ? ['standard', 'priority'] : ['standard'];

/** The TOML candidates of one model: today's price retimed to the run, then scheduled windows */
const tomlPricesOf = (model: string, parsed: ParsedTomlPrice, now: Date, from: Date): readonly TaggedPrice[] => {
    const result: TaggedPrice[] = [];
    for (const tier of tiersOf(model)) {
        const windows = tier === 'standard' ? parsed.standard : parsed.priority;
        for (const window of windowedPrices(windows, now, from)) {
            result.push({ model, tier, from: window.from, to: window.to, values: window.values, perImageUsd: null, sourceKind: 'models-dev' });
        }
    }
    return result;
};

/** The official candidates of one model; rows our routes never use (non-global) are already dropped */
const officialPricesOf = (
    model: string,
    prices: readonly OfficialPrice[],
    now: Date,
    from: Date
): readonly TaggedPrice[] => {
    const result: TaggedPrice[] = [];
    for (const tier of tiersOf(model)) {
        const tierPrices = prices.filter((price) => price.tier === tier);
        // Each window states absolute prices, so normalize them as one-window rows
        for (const window of windowedPrices(
            tierPrices.map((price) => ({ from: price.from, to: price.to, values: price.values })),
            now,
            from
        )) {
            result.push({ model, tier, from: window.from, to: window.to, values: window.values, perImageUsd: null, sourceKind: 'official' });
        }
    }
    return result;
};

/** Compare the official page with the TOML baseline for the same model and tell the owner */
const compareOfficialWithToml = (
    model: string,
    official: readonly TaggedPrice[],
    toml: readonly TaggedPrice[],
    warnings: string[]
): boolean => {
    const differences: string[] = [];
    for (const price of official) {
        const baseline = toml.find((candidate) => candidate.tier === price.tier && candidate.from.getTime() === price.from.getTime());
        if (baseline === undefined) continue;
        const pairs: readonly (readonly [keyof ChannelValues, string])[] = [
            ['input', '输入'],
            ['cached', '缓存读'],
            ['output', '文本输出'],
            ['imageOutput', '图片输出'],
        ];
        for (const [field, label] of pairs) {
            const baseValue = baseline.values[field];
            const officialValue = price.values[field];
            if (baseValue === null || officialValue === null) continue;
            if (!samePrice(baseValue, officialValue)) {
                differences.push(`${label} ${formatPrice(baseValue)} vs ${formatPrice(officialValue)}`);
            }
        }
    }
    if (differences.length > 0) {
        warnings.push(`${model}：models.dev 与 Vertex 官方页不一致（${differences.join('、')}），采用官方值`);
        return false;
    }
    return true;
};

/** ephone can only fill a model the other sources left without any price */
const ephonePricesOf = (
    ref: CatalogModelRef,
    ephone: ReadonlyMap<string, EphonePrice>,
    now: Date,
    from: Date,
    warnings: string[]
): readonly TaggedPrice[] => {
    const price = ephone.get(ref.model);
    if (price === undefined) {
        warnings.push(`ephone 也没有 ${ref.model} 的价，保持未定价`);
        return [];
    }
    if (price.currency !== 'USD') {
        warnings.push(`${ref.model}：ephone 价以 ${price.currency} 标价，无法换算 USD，保持未定价`);
        return [];
    }
    const values: ChannelValues = {
        input: price.input ?? 0,
        cached: price.cached ?? price.input ?? 0,
        output: price.output ?? 0,
        cacheWrite: null,
        imageOutput: null,
    };
    const windows = windowedPrices([{ from: BEGINNING, to: undefined, values }], now, from);
    return windows.map((window) => ({
        model: ref.model,
        tier: 'standard',
        from: window.from,
        to: window.to,
        values: window.values,
        perImageUsd: price.perImageUsd,
        sourceKind: 'ephone',
    }));
};

/**
 * Cross-checks every candidate in force today against LiteLLM and, when the
 * sources agree everywhere it could compare, says so in the candidate note.
 * Mismatches only warn: a single community file never becomes a proposal.
 */
const crossCheckLitellm = (
    candidates: readonly PriceCandidate[],
    litellm: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
    now: Date,
    warnings: string[]
): ReadonlySet<string> => {
    const mismatchDetails = new Map<string, string[]>();
    const confirmed = new Set<string>();
    const compared = new Map<string, number>();
    for (const candidate of candidates) {
        const entry = candidate.entry;
        if (entry.effectiveFrom.getTime() > now.getTime()) continue;
        const key = LITELLM_KEYS[entry.model] ?? entry.model;
        const node = litellm.get(key);
        if (node === undefined) continue;
        const imageModel = entry.imageOutputPerM !== undefined;
        const cost = litellmCostOf(node, entry.tier, imageModel);
        const pairs: (readonly [number | null, number, string])[] = [
            [cost.input, entry.inputPerM, '输入'],
            [cost.cached, entry.cachedInputPerM, '缓存读'],
            [cost.output, entry.outputPerM, '输出'],
        ];
        // Image output only exists on standard-tier image rows; a priority row
        // deliberately carries no image price
        if (entry.imageOutputPerM !== undefined) pairs.push([cost.imageOutput, entry.imageOutputPerM, '图片输出']);
        const modelDetails = mismatchDetails.get(entry.model) ?? [];
        for (const [litellmValue, candidateValue, label] of pairs) {
            if (litellmValue === null) continue;
            compared.set(entry.model, (compared.get(entry.model) ?? 0) + 1);
            if (!samePrice(litellmValue, candidateValue)) {
                modelDetails.push(`${label} ${formatPrice(candidateValue)} vs ${formatPrice(litellmValue)}`);
            }
        }
        mismatchDetails.set(entry.model, modelDetails);
    }
    for (const [model, details] of mismatchDetails) {
        if (details.length > 0) {
            warnings.push(`${model}：LiteLLM 与主源不一致（${details.join('、')}）`);
            continue;
        }
        if ((compared.get(model) ?? 0) > 0) confirmed.add(model);
    }
    return confirmed;
};

const withNote = (candidates: readonly PriceCandidate[], confirmed: ReadonlySet<string>): readonly PriceCandidate[] =>
    candidates.map((candidate) => {
        if (!confirmed.has(candidate.entry.model)) return candidate;
        const note = `${candidate.note ?? SOURCE_LABELS[candidate.sourceKind]}，LiteLLM 一致`;
        return { ...candidate, note, entry: { ...candidate.entry, note } };
    });

/**
 * Turns the downloaded documents into candidate rows: today's price for every
 * model and tier, plus the scheduled windows the sources state. Every failure
 * path ends in a warning; the function never throws.
 */
export const compilePriceCandidates = (result: CatalogFetchResult, options: CompileOptions): CompileResult => {
    const warnings: string[] = [];
    const now = options.now;
    const from = runFrom(now);
    const checkedOn = isoDay(now);
    const documents = result.documents;

    // 1. models.dev baseline, in menu order
    const tomlByModel = new Map<string, readonly TaggedPrice[]>();
    for (const ref of CATALOG_MODEL_REFS) {
        if (ref.modelFile === '') continue;
        const body = documents.tomlByModel.get(ref.model);
        if (body === undefined) {
            warnings.push(`models.dev 没有 ${ref.model} 的 TOML，该模型只使用其它源`);
            continue;
        }
        const parsed = parseTomlPrice(body, ref.model, warnings);
        if (parsed === null) continue;
        const prices = tomlPricesOf(ref.model, parsed, now, from);
        if (prices.length === 0) {
            warnings.push(`models.dev 的 ${ref.model} 价目窗口都已过期，本次不生成候选`);
            continue;
        }
        tomlByModel.set(ref.model, prices);
    }

    // 2. official Vertex page: Gemini values win, priority and promo windows come from here
    const official = documents.vertexPricingHtml === null ? null : parseVertexPricing(documents.vertexPricingHtml);
    if (official === null) warnings.push('官方 Vertex 页不可用：Gemini 价格只来自 models.dev TOML');
    else warnings.push(...official.warnings);
    const officialByModel = new Map<string, readonly TaggedPrice[]>();
    for (const ref of CATALOG_MODEL_REFS) {
        const modelPrices = official === null ? [] : official.prices.filter((price) => price.model === ref.model);
        if (modelPrices.length === 0) continue;
        const prices = officialPricesOf(ref.model, modelPrices, now, from);
        if (prices.length === 0) {
            warnings.push(`官方 Vertex 页的 ${ref.model} 价目窗口都已过期，沿用 models.dev TOML`);
            continue;
        }
        officialByModel.set(ref.model, prices);
    }
    for (const model of OFFICIAL_MODEL_IDS) {
        if (official !== null && !officialByModel.has(model)) warnings.push(`官方 Vertex 页未解析到 ${model}，沿用 models.dev TOML`);
    }

    // 3. pick the source per model and compare official against the baseline
    const tagged: TaggedPrice[] = [];
    const notes = new Map<string, string>();
    for (const ref of CATALOG_MODEL_REFS) {
        const tomlPrices = tomlByModel.get(ref.model) ?? [];
        const officialPrices = officialByModel.get(ref.model);
        if (officialPrices !== undefined) {
            const agrees = compareOfficialWithToml(ref.model, officialPrices, tomlPrices, warnings);
            if (agrees) notes.set(ref.model, 'Vertex 官方页，与 models.dev 一致');
            else notes.set(ref.model, 'Vertex 官方页（覆盖 models.dev）');
            tagged.push(...officialPrices);
            continue;
        }
        if (tomlPrices.length > 0) {
            notes.set(ref.model, SOURCE_LABELS['models-dev']);
            tagged.push(...tomlPrices);
        }
    }

    // 4. ephone only fills models that have no price at all (relay-only image id)
    const pricedModels = new Set(tagged.map((price) => price.model));
    if (documents.ephonePricingJson !== null) {
        const ephone = parseEphoneCatalog(documents.ephonePricingJson, warnings);
        for (const ref of CATALOG_MODEL_REFS) {
            if (pricedModels.has(ref.model)) continue;
            const prices = ephonePricesOf(ref, ephone, now, from, warnings);
            if (prices.length > 0) {
                notes.set(ref.model, `${SOURCE_LABELS.ephone}（低置信）`);
                tagged.push(...prices);
            }
        }
    }

    // 5. LiteLLM cross-check, then assemble in menu order
    const litellm = documents.litellmJson === null ? null : parseLitellmCatalog(documents.litellmJson, warnings);
    if (litellm === null) warnings.push('LiteLLM 价目表不可用：本次没有交叉校验');
    const byModel = new Map<string, TaggedPrice[]>();
    for (const price of tagged) {
        const list = byModel.get(price.model) ?? [];
        list.push(price);
        byModel.set(price.model, list);
    }
    const usable: PriceCandidate[] = [];
    for (const ref of CATALOG_MODEL_REFS) {
        for (const price of byModel.get(ref.model) ?? []) {
            const note = notes.get(price.model) ?? SOURCE_LABELS[price.sourceKind];
            usable.push({
                entry: entryOfCandidate(
                    ref,
                    price.tier,
                    price.from,
                    price.to,
                    price.values,
                    price.perImageUsd,
                    price.sourceKind,
                    checkedOn,
                    note
                ),
                sourceKind: price.sourceKind,
                note,
            });
        }
    }
    const confirmed = litellm === null ? new Set<string>() : crossCheckLitellm(usable, litellm, now, warnings);
    return { candidates: withNote(usable, confirmed), warnings };
};

// ---------------------------------------------------------------------------
// Differ
// ---------------------------------------------------------------------------

/** The row a proposal writes, with its provenance and the baseline's local extras */
const proposalEntryOf = (candidate: PriceCandidate, baseline: PriceEntry | null, checkedOn: string): PriceEntry => {
    const entry = candidate.entry;
    const overlays =
        baseline === null || candidate.entry.tier === 'priority'
            ? {}
            : {
                  ...(entry.cacheWritePerM === undefined && baseline.cacheWritePerM !== undefined ? { cacheWritePerM: baseline.cacheWritePerM } : {}),
                  ...(entry.imageOutputPerM === undefined && baseline.imageOutputPerM !== undefined ? { imageOutputPerM: baseline.imageOutputPerM } : {}),
                  ...(entry.perImageUsd === undefined && baseline.perImageUsd !== undefined ? { perImageUsd: baseline.perImageUsd } : {}),
              };
    return {
        ...entry,
        ...overlays,
        source: sourceOf(candidate.sourceKind),
        confidence: confidenceOf(candidate.sourceKind),
        checkedOn,
        ...(candidate.note === null ? {} : { note: candidate.note }),
    };
};

/** A price no table should ever carry: negative, all zero, or a >10× jump over the baseline */
const sanityProblemOf = (baseline: PriceEntry | null, entry: PriceEntry): string | null => {
    const values = PRICE_FIELDS.map((field) => entry[field]).filter((value): value is number => value !== undefined);
    if (values.length === 0) return '没有任何价格字段';
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return '含负数或非有限价格';
    if (!values.some((value) => value > 0)) return '所有价格都是 0';
    if (baseline === null) return null;
    for (const field of PRICE_FIELDS) {
        const baseValue = baseline[field];
        const value = entry[field];
        if (baseValue === undefined || value === undefined || baseValue <= 0) continue;
        if (value / baseValue > MAX_PRICE_GROWTH) {
            return `${PRICE_FIELD_LABELS[field]}涨幅超过 ${MAX_PRICE_GROWTH} 倍（${formatPrice(baseValue)} → ${formatPrice(value)}）`;
        }
    }
    return null;
};

const sourceNoteOf = (candidate: PriceCandidate): string => candidate.note ?? SOURCE_LABELS[candidate.sourceKind];

/**
 * Compares candidates with the rows in force and returns what the owner should
 * approve. Only prices are compared, never row identities: an approved
 * historical window is not "different", and a row whose `effectiveTo` merely
 * moves is not a change either. Rows the sources did not cover at all are
 * reported as warnings, not proposals.
 */
export const diffPriceCandidates = (
    candidates: readonly PriceCandidate[],
    current: readonly PriceEntry[],
    options: CompileOptions
): { readonly drafts: readonly ProposalDraft[]; readonly warnings: readonly string[] } => {
    const warnings: string[] = [];
    const drafts: ProposalDraft[] = [];
    const now = options.now;
    const checkedOn = isoDay(now);
    const from = runFrom(now);
    const seen = new Set<string>();
    // One candidate per (model, tier, start): the higher-priority source wins
    const chosen = new Map<string, PriceCandidate>();
    for (const candidate of candidates) {
        const key = `${candidate.entry.model}|${candidate.entry.tier}|${candidate.entry.effectiveFrom.getTime()}`;
        const existing = chosen.get(key);
        if (existing === undefined || SOURCE_PRIORITY[candidate.sourceKind] < SOURCE_PRIORITY[existing.sourceKind]) {
            chosen.set(key, candidate);
        }
    }
    const modelHasEntries = (model: string): boolean => current.some((row) => row.model === model);
    const push = (draft: ProposalDraft): void => {
        const key = `${draft.kind}|${draft.model}|${draft.tier}|${draft.entry.effectiveFrom.getTime()}`;
        if (seen.has(key)) return;
        seen.add(key);
        drafts.push(draft);
    };
    for (const candidate of chosen.values()) {
        const entry = candidate.entry;
        const isCurrent = entry.effectiveFrom.getTime() <= now.getTime();
        if (isCurrent && entry.effectiveFrom.getTime() !== from.getTime()) {
            warnings.push(`${entry.model}/${entry.tier}：候选当前档的起点不是本次运行时刻，跳过`);
            continue;
        }
        // A row at the exact same start is what a re-run of this proposal wrote
        const exact = exactRowAt(current, entry.model, entry.tier, entry.effectiveFrom);
        const baseline = exact ?? entryInForceAt(current, entry.model, entry.tier, isCurrent ? now : entry.effectiveFrom);
        if (baseline !== null && priceDifferences(baseline, entry).length === 0) continue;
        const sanity = sanityProblemOf(baseline, entry);
        if (sanity !== null) {
            warnings.push(`${entry.model}/${entry.tier}：${sanity}，跳过该提案`);
            continue;
        }
        const proposal = proposalEntryOf(candidate, baseline, checkedOn);
        const source = sourceNoteOf(candidate);
        const timing = isCurrent ? '' : `（${isoDay(entry.effectiveFrom)} 起生效）`;
        if (baseline === null) {
            const hasModelRows = modelHasEntries(entry.model);
            const hasTierRows = current.some((row) => row.model === entry.model && row.tier === entry.tier);
            const otherTierInForce = entryInForceAt(current, entry.model, otherTier(entry.tier), now) !== null;
            // No row in force at the run instant: a new model (or one whose
            // windows are all over). A future window of a priced model is just
            // a scheduled change, and a tier never seen before is an new tier.
            const kind: 'update' | 'new_model' = isCurrent ? (hasModelRows && otherTierInForce ? 'update' : 'new_model') : hasModelRows ? 'update' : 'new_model';
            const label = kind === 'new_model' ? '新模型' : !hasTierRows ? '新增档位' : null;
            const suffix = label === null ? '' : `（${label}）`;
            push({
                kind,
                model: entry.model,
                tier: entry.tier,
                entry: proposal,
                baseline: null,
                note: `${entry.model} · ${entry.tier}${timing}${suffix}：${priceSummary(proposal)}（${source}）`,
            });
            continue;
        }
        push({
            kind: 'update',
            model: entry.model,
            tier: entry.tier,
            entry: proposal,
            baseline,
            note: `${entry.model} · ${entry.tier}${timing}：${priceSummary(baseline)} → ${priceSummary(proposal)}（${source}）`,
        });
    }

    // Expiring rows without a successor: a reminder, never a write
    for (const row of current) {
        const end = row.effectiveTo?.getTime();
        if (end === undefined || end <= now.getTime() || end > now.getTime() + EXPIRY_HORIZON_MS) continue;
        const hasSuccessor =
            current.some((other) => other.model === row.model && other.tier === row.tier && other.effectiveFrom.getTime() >= end) ||
            candidates.some(
                (candidate) =>
                    candidate.entry.model === row.model &&
                    candidate.entry.tier === row.tier &&
                    candidate.entry.effectiveFrom.getTime() >= end
            );
        if (hasSuccessor) continue;
        push({
            kind: 'expiry',
            model: row.model,
            tier: row.tier,
            entry: row,
            baseline: null,
            note: `${row.model} · ${row.tier}：现价 ${priceSummary(row)} 将于 ${isoDay(new Date(end))} 到期，目录没有后继价`,
        });
    }

    // Current rows no source covered at all: the table keeps them, the owner should know
    const candidateTiers = new Set([...chosen.values()].map((candidate) => `${candidate.entry.model}|${candidate.entry.tier}`));
    const warnedMissing = new Set<string>();
    for (const row of current) {
        const end = row.effectiveTo?.getTime();
        if (end !== undefined && end <= now.getTime()) continue;
        const tierKey = `${row.model}|${row.tier}`;
        if (candidateTiers.has(tierKey)) continue;
        if (warnedMissing.has(tierKey)) continue;
        warnedMissing.add(tierKey);
        warnings.push(`${tierKey}：目录没有该模型的价（源缺价），保留现有行`);
    }

    return { drafts, warnings };
};
