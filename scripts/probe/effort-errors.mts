/**
 * Error classification for the thinking-effort probe.
 *
 * The distinction that matters: "this lane did not accept this effort value"
 * must never be confused with "the key is wrong", "the model does not exist",
 * "we are rate-limited" or "the relay is broken". A misclassification would
 * turn a temporary token or a renamed model into "the effort is unsupported"
 * and shrink the product's effort menu forever (probe results are imported
 * through the owner's approval flow).
 *
 * Rules: probe plan §3. Status codes outrank text, and only a 400/422 whose
 * text names the effort/thinking parameter counts as a rejection. Everything
 * else lands in `unclassified` — import may then ignore it, never assume.
 */
import { ERROR_FINGERPRINT_LIMIT, ERROR_SUMMARY_LIMIT, type ProbePlatform } from './effort-types.mts';

export type ProbeErrorClass =
    | 'auth_error'
    | 'model_missing'
    | 'lane_error'
    | 'rate_limited'
    | 'upstream_error'
    | 'network_error'
    | 'rejected_effort'
    | 'rejected_other'
    | 'stream_error'
    | 'unclassified';

export interface ProbeErrorInput {
    readonly platform: ProbePlatform;
    /** HTTP status when a response arrived; null for transport failures */
    readonly status: number | null;
    /** Raw response body (or SSE error payload) as text; may be empty */
    readonly raw: string;
    /** Message of the error the SDK threw; often carries the same body */
    readonly thrownMessage?: string;
    /** The failure happened after a 2xx response opened and mid-stream broke */
    readonly duringStream?: boolean;
}

export interface ProbeErrorClassification {
    readonly errorClass: ProbeErrorClass;
    readonly fingerprint: string;
    /** Redacted, truncated text for the evidence file and the import preview */
    readonly summary: string;
    /** One retry is allowed for these (probe plan §5) */
    readonly retryable: boolean;
    /** Further candidates of this platform stop: the lane is unusable now */
    readonly stopsLane: boolean;
    /** Further candidates of this model stop (missing model / bad key scope) */
    readonly stopsModel: boolean;
    /** The whole run stops (wrong credentials: keep spending would only leak) */
    readonly stopsRun: boolean;
    readonly effortRejection: boolean;
}

const AUTH_TEXT =
    /invalid api[ _-]?key|incorrect api[ _-]?key|unauthori[sz]ed|no auth|authentication|permission denied|api key.*(invalid|expired|revoked)|(invalid|expired).*(api key|credentials)|credentials.*(invalid|expired)|could not load (the )?default credentials|cannot load (the )?default credentials/i;

const MODEL_MISSING_TEXT =
    /model[^.]{0,80}(not found|not exist|does not exist|not available|unknown|no available (channel|account)|is unavailable|does not support this protocol|not supported by (the )?(lanes?|channels?))/i;

const RATE_LIMITED_TEXT =
    /rate[ _-]?limit|too many requests|quota|exhausted|insufficient (balance|credit|funds)|余额|额度|requests per|tokens per|retry after/i;

const UPSTREAM_TEXT =
    /overloaded|unavailable|bad gateway|gateway timeout|service (temporarily )?unavailable|internal server error|upstream|no channel|channel (error|unavailable)|requires billing|上游|渠道/i;

const NETWORK_TEXT =
    /etimedout|econnreset|econnrefused|enotfound|eai_again|fetch failed|network|socket hang up|timed? ?out|aborted|timeout|terminated/i;

const REJECTION_WORD = /unsupported|not supported|does not support|cannot be used|invalid|unknown|unrecognized|unexpected|not permitted|extra inputs|must be one of|not one of|input should be|expected one of|is not a valid|not allowed|only supports|not available/i;

/**
 * Platform fingerprints of "the effort/thinking parameter was rejected".
 * A hit needs both a mention of the parameter family and a rejection word;
 * "reasoning is required" or "reasoning_content missing" therefore stays
 * unclassified instead of becoming a fake rejection (probe plan §3.1).
 */
const EFFORT_FINGERPRINTS: Readonly<Record<ProbePlatform, readonly RegExp[]>> = {
    gemini: [
        /thinking[ _]?(level|budget|config)/i,
        /thinkingLevel|thinkingBudget/,
        /thinking level is unsupported/i,
        /thinking budget is not supported/i,
    ],
    openai: [/reasoning[ _.]?(effort)?/i, /(unsupported|invalid|unknown|unrecognized)[^.]{0,80}reasoning/i, /effort/i],
    anthropic: [/output_config/i, /effort/i, /thinking[ _.]?type/i, /adaptive/i, /budget_tokens/i],
    grok: [/reasoning/i, /effort/i],
    deepseek: [/reasoning_effort/i, /reasoning/i, /thinking[ _.]?type/i],
    mimo: [/thinking[ _.]?(type)?/i, /reasoning/i],
};

/** 400s that name a parameter other than the effort family (tools, media, …) */
const OTHER_PARAMETER_TEXT =
    /tools?[^.]{0,40}(not supported|unsupported|invalid|unknown)|function[ _]?(declaration|calling)|schema|image[ _]?(size|input|type)|audio|video|max[ _]?(tokens|output)|max_tokens|system[ _]?instruction|response_format|modality|input_file|content[ _]?filter|moderation|safety[ _]?system|风控/i;

/** Whether the text names the effort/thinking parameter family at all */
const mentionsEffortFamily = (platform: ProbePlatform, text: string): boolean =>
    (EFFORT_FINGERPRINTS[platform] ?? []).some((pattern) => pattern.test(text));

/** Generic secret redaction; known secret values are additionally replaced by the runner */
const SECRET_PATTERNS: readonly RegExp[] = [
    /sk-[A-Za-z0-9_-]{8,}/g,
    /xai-[A-Za-z0-9_-]{8,}/g,
    /AIza[0-9A-Za-z_-]{20,}/g,
    /gh[pousr]_[A-Za-z0-9]{20,}/g,
    /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    /([?&](?:key|api_key|api-key|access_token|token)=)[^&\s"']+/gi,
    /((?:api[_-]?key|access[_-]?token|secret|password|credential)s?["'\s]*[:=]\s*)[^\s,"'}]{6,}/gi,
];

/** Replace obvious credentials and inline key URL parameters */
export const redactSecrets = (text: string): string =>
    SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '$1<redacted>'), text);

/**
 * A redactor that also forgets the exact secret values of this run. The runner
 * builds it from `.env.test` credentials; tests use it to prove keys cannot
 * reach the evidence files even when an upstream echoes the request.
 */
export const createRedactor = (secretValues: readonly string[]): ((text: string) => string) => {
    // Longest first, so a key that contains another one is fully removed
    const secrets = [...new Set(secretValues.filter((value) => value.length >= 8))].sort(
        (left, right) => right.length - left.length
    );
    return (text: string): string => {
        let current = redactSecrets(text);
        for (const secret of secrets) current = current.split(secret).join('<redacted>');
        return current;
    };
};

/** The human-readable part of an error body: JSON `error.message`, plain text, … */
export const messageFromBody = (raw: string): string => {
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const record = Object.fromEntries(Object.entries(parsed));
            const error = record['error'];
            if (typeof error === 'string') return error;
            if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
                const errorRecord = Object.fromEntries(Object.entries(error));
                for (const key of ['message', 'detail', 'code', 'type', 'status']) {
                    const value = errorRecord[key];
                    if (typeof value === 'string' && value !== '') return value;
                }
            }
            for (const key of ['message', 'detail', 'error_message', 'msg']) {
                const value = record[key];
                if (typeof value === 'string' && value !== '') return value;
            }
        }
        return trimmed;
    } catch {
        return trimmed;
    }
};

const compact = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Normalize an error into an aggregation key: lowercase, no ids/numbers,
 * quotes collapsed, whitespace folded (probe plan §3.3 step 8).
 */
export const fingerprintOf = (text: string): string =>
    compact(
        text
            .toLowerCase()
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
            .replace(/\b[0-9a-f]{24,}\b/g, '<hex>')
            .replace(/\d+/g, '<n>')
            .replace(/["'`]/g, ' ')
    ).slice(0, ERROR_FINGERPRINT_LIMIT);

/** Redacted, truncated summary for the evidence file */
export const summarizeError = (text: string, redact: (value: string) => string): string =>
    compact(redact(text)).slice(0, ERROR_SUMMARY_LIMIT);

interface ClassificationBody {
    readonly errorClass: ProbeErrorClass;
    readonly retryable?: boolean;
    readonly stopsLane?: boolean;
    readonly stopsModel?: boolean;
    readonly stopsRun?: boolean;
    readonly effortRejection?: boolean;
}

const classification = (
    errorClass: ProbeErrorClass,
    options: Omit<ClassificationBody, 'errorClass'> = {}
): ClassificationBody => ({ errorClass, ...options });

/** Full classification of one failed request */
export const classifyProbeError = (
    input: ProbeErrorInput,
    redact: (text: string) => string = redactSecrets
): ProbeErrorClassification => {
    const bodyText = messageFromBody(input.raw);
    const thrown = input.thrownMessage ?? '';
    // The thrown message is the SDK's own rendering; keep both, body first
    const text = compact(`${bodyText} ${thrown}`);
    const status = input.status;
    const duringStream = input.duringStream === true;

    const body: ClassificationBody = (() => {
        if (status === 401 || status === 403 || AUTH_TEXT.test(text)) {
            return classification('auth_error', { stopsRun: true });
        }
        if (status === 404 || MODEL_MISSING_TEXT.test(text)) {
            return classification('model_missing', { stopsModel: true });
        }
        if (status === 429 || RATE_LIMITED_TEXT.test(text)) {
            return classification('rate_limited', { retryable: true });
        }
        if (status !== null && status >= 500) {
            return classification('upstream_error', { retryable: true });
        }
        if (status === null) {
            if (duringStream) return classification('stream_error');
            if (NETWORK_TEXT.test(text)) return classification('network_error', { retryable: true });
            if (UPSTREAM_TEXT.test(text)) return classification('upstream_error', { retryable: true });
            return classification('unclassified');
        }
        if (status >= 500) return classification('upstream_error', { retryable: true });
        if (status === 408) return classification('network_error', { retryable: true });
        // Parameter rejections: only 400/422 can be a rejected effort value
        if (status === 400 || status === 422) {
            if (mentionsEffortFamily(input.platform, text) && REJECTION_WORD.test(text)) {
                return classification('rejected_effort');
            }
            if (OTHER_PARAMETER_TEXT.test(text) || REJECTION_WORD.test(text)) {
                return classification('rejected_other');
            }
            return classification('unclassified');
        }
        if (duringStream) return classification('stream_error');
        if (UPSTREAM_TEXT.test(text)) return classification('upstream_error', { retryable: true });
        return classification('unclassified');
    })();

    return {
        ...body,
        retryable: body.retryable === true,
        stopsLane: body.stopsLane === true,
        stopsModel: body.stopsModel === true,
        stopsRun: body.stopsRun === true,
        effortRejection: body.effortRejection === true || body.errorClass === 'rejected_effort',
        fingerprint: fingerprintOf(text),
        summary: summarizeError(text === '' ? `HTTP ${status ?? 'n/a'}` : text, redact),
    };
};

/** Chinese label for summary.md; keeps the class list in one place */
export const ERROR_CLASS_LABELS: Readonly<Record<ProbeErrorClass, string>> = {
    auth_error: '鉴权失败',
    model_missing: '模型不存在',
    lane_error: '通道错误',
    rate_limited: '限流/额度',
    upstream_error: '上游错误',
    network_error: '网络错误',
    rejected_effort: '档位被拒',
    rejected_other: '其它参数被拒',
    stream_error: '流内错误',
    unclassified: '未分类',
};

/** Error classes that mean "the lane answered, but not with success" */
export const isRejectionClass = (errorClass: string): boolean =>
    errorClass === 'rejected_effort' || errorClass === 'rejected_other' || errorClass === 'unclassified' || errorClass === 'stream_error';

/** True when a string is one of the classified error classes */
const isErrorClass = (value: string): value is ProbeErrorClass =>
    Object.prototype.hasOwnProperty.call(ERROR_CLASS_LABELS, value);

/** Chinese label of an error class name, when it is a known one */
export const errorClassLabel = (errorClass: string): string =>
    isErrorClass(errorClass) ? ERROR_CLASS_LABELS[errorClass] : errorClass;
