/**
 * comfy-forward client (API 2.1.0) — see docs/comfy-forward-API.md.
 *
 * Deliberately free of any grammy/Telegram concern: it speaks HTTP, returns
 * plain data, and turns every failure into a `ComfyError` carrying a Chinese
 * `userMessage` the command layer can post verbatim. That split is what lets
 * the whole thing be tested offline against a stub server.
 *
 * Generation goes through the ASYNC endpoints (submit → poll → download). The
 * synchronous `/generate` the old /piczit used holds one HTTP connection open
 * for the entire run, which the reverse proxy in front of the box cuts long
 * before FLUX.2 is done.
 */
import { match } from 'ts-pattern';

/** COMFY_FORWARD_URL, with the retired PICZIT_ENDPOINT as a fallback */
const baseUrl = (process.env.COMFY_FORWARD_URL ?? process.env.PICZIT_ENDPOINT ?? '').replace(
    /\/+$/,
    ''
);

if (!process.env.COMFY_FORWARD_URL && process.env.PICZIT_ENDPOINT) {
    console.warn(
        '[comfy] COMFY_FORWARD_URL is unset, falling back to the legacy PICZIT_ENDPOINT'
    );
}

/** Whether image generation is configured at all */
export const isComfyConfigured = (): boolean => Boolean(baseUrl);

// The box is behind a home connection and a TLS-terminating proxy. The name
// resolves to both an IPv4 and an IPv6 address and the first connection from a
// process measured ~4s (warm ones ~300ms), so a 2s budget reported a perfectly
// healthy service as down.
const envTimeout = (name: string, fallback: number): number => {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};
const HEALTH_TIMEOUT_MS = envTimeout('COMFY_HEALTH_TIMEOUT_MS', 20_000);
const SUBMIT_TIMEOUT_MS = envTimeout('COMFY_SUBMIT_TIMEOUT_MS', 150_000);
const POLL_TIMEOUT_MS = envTimeout('COMFY_POLL_TIMEOUT_MS', 15_000);
// The uplink measured ~66 KB/s, so a 1.3 MB FLUX.2 output needs ~20s and 60s
// was losing pictures that had already been generated. But a connection to
// this host also just hangs sometimes (the name has an IPv6 address nothing
// here can reach), and a long budget turns that into a long dead wait — so the
// budget is generous rather than huge, and the retries above do the rest.
const DOWNLOAD_TIMEOUT_MS = envTimeout('COMFY_DOWNLOAD_TIMEOUT_MS', 300_000);

/** How long a cached workflow list stays fresh */
const WORKFLOWS_TTL_MS = 5 * 60 * 1000;

/** Decoded input image cap, per the API docs (20 MiB) */
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;

export type WorkflowKind = 'text-to-image' | 'image-edit';

export interface ComfyWorkflow {
    id: string;
    name: string;
    kind: string;
    input_image_required: boolean;
    default_options: Record<string, unknown>;
}

/**
 * Used when `/v1/workflows` cannot be reached. Only costs us auto-discovery of
 * workflows added after this was written; the two below have been there since
 * 2.1.0.
 */
const FALLBACK_WORKFLOWS: ComfyWorkflow[] = [
    {
        id: 'z-image-turbo',
        name: 'Z-Image Turbo 文生图',
        kind: 'text-to-image',
        input_image_required: false,
        default_options: {},
    },
    {
        id: 'flux2-klein-9b-base-edit',
        name: 'FLUX.2 Klein 9B Base NSFW Standard 图像编辑',
        kind: 'image-edit',
        input_image_required: true,
        default_options: {},
    },
];

export type GenerationOptionValue = number | string | boolean;

export interface GenerationRequest {
    workflow: string;
    prompt: string;
    negative_prompt?: string;
    negative_prompt_override?: boolean;
    input_image?: { data: string; filename?: string };
    options?: Record<string, GenerationOptionValue>;
}

export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface GeneratedImageRef {
    index: number;
    filename: string;
    url: string;
}

export interface GenerationJob {
    id: string;
    status: GenerationStatus;
    images: GeneratedImageRef[];
    error?: string;
}

/**
 * A failure with something we are willing to show the user. `retryable` marks
 * the transient ones (connection blips), which the poller tolerates a few of
 * before giving up — the box is on a home connection.
 */
export class ComfyError extends Error {
    readonly userMessage: string;
    readonly retryable: boolean;

    constructor(userMessage: string, detail: string, retryable = false) {
        super(detail);
        this.name = 'ComfyError';
        this.userMessage = userMessage;
        this.retryable = retryable;
    }
}

/** The API's error envelope: `{ error, message }` */
const readErrorMessage = async (response: Response): Promise<string> => {
    const body: unknown = await response.json().catch(() => null);
    if (typeof body === 'object' && body !== null && 'message' in body) {
        const { message } = body;
        if (typeof message === 'string' && message) return message;
    }
    return `HTTP ${response.status}`;
};

/** HTTP status → what the user reads. Mirrors the table in the API docs. */
const describeStatus = (status: number, detail: string): string =>
    match(status)
        .with(400, () => `参数不合法：${detail}`)
        .with(401, () => '生图服务要求鉴权，但 bot 没有配置凭据')
        .with(404, () => '任务已经不在服务端了（可能重启过），请重新发一次命令')
        .with(413, () => '参考图太大了，换一张小一点的')
        .with(422, () => `模型拒绝了这组参数：${detail}`)
        .with(500, 502, () => `生成失败（多半是显存不够）：${detail}\n可以试试 -n=1 或更小的 -size=`)
        .with(503, () => '生图服务未启动')
        .with(504, () => '生成超时')
        .otherwise(() => `生图服务返回了 HTTP ${status}：${detail}`);

/**
 * Network-level failures never reach an HTTP status. `fetch` reports most of
 * them as a bare `TypeError: fetch failed` and hides the real reason in
 * `cause`, so both are kept in the detail — without it a connection problem is
 * indistinguishable from a timeout in the log.
 */
const describeTransport = (error: unknown): ComfyError => {
    const cause = error instanceof Error ? error.cause : undefined;
    const causeMessage = cause instanceof Error ? `${cause.name}: ${cause.message}` : undefined;
    const detail = error instanceof Error
        ? [error.name, error.message, causeMessage].filter(Boolean).join(' / ')
        : String(error);

    const names = [
        error instanceof Error ? error.name : '',
        cause instanceof Error ? cause.name : '',
        cause instanceof Error ? String(Reflect.get(cause, 'code') ?? '') : '',
    ].join(' ');
    const timedOut = /timeout/i.test(names);

    return new ComfyError(timedOut ? '生图服务没有响应（超时）' : '连不上生图服务', detail, true);
};

interface RequestOptions {
    method?: 'GET' | 'POST';
    body?: unknown;
    timeoutMs: number;
    /** Extra attempts after a transport failure (HTTP errors are never retried) */
    retries?: number;
}

const TRANSPORT_RETRY_DELAY_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const requestOnce = async (path: string, options: RequestOptions): Promise<Response> => {
    if (!baseUrl) {
        throw new ComfyError('生图服务未配置', 'COMFY_FORWARD_URL is empty');
    }

    let response: Response;
    try {
        response = await fetch(`${baseUrl}${path}`, {
            method: options.method ?? 'GET',
            headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: AbortSignal.timeout(options.timeoutMs),
        });
    } catch (error) {
        throw describeTransport(error);
    }

    if (!response.ok) {
        const detail = await readErrorMessage(response);
        throw new ComfyError(describeStatus(response.status, detail), `${path}: ${detail}`);
    }

    return response;
};

/**
 * The link to the box drops a connection now and then (undici reports it as a
 * bare `fetch failed` wrapping an AggregateError, because the name resolves to
 * an IPv6 address nothing here can reach). Losing a finished picture to one of
 * those is not acceptable, so transport failures — and only those — are
 * retried; an HTTP status is an answer and gets passed straight up.
 *
 * Reading the body is part of the attempt, not something the caller does after:
 * the abort signal covers the body stream too, so a download that stalls
 * mid-transfer has to be mapped and retried like any other transport failure.
 */
const request = async <T>(
    path: string,
    options: RequestOptions,
    read: (response: Response) => Promise<T>
): Promise<T> => {
    const attempts = (options.retries ?? 0) + 1;

    for (let attempt = 1; ; attempt += 1) {
        try {
            const response = await requestOnce(path, options);
            try {
                return await read(response);
            } catch (error) {
                throw describeTransport(error);
            }
        } catch (error) {
            const transient = error instanceof ComfyError && error.retryable;
            if (!transient || attempt >= attempts) throw error;
            console.warn(
                `[comfy] ${path} failed (attempt ${attempt}/${attempts}): ${error.message}`
            );
            await sleep(TRANSPORT_RETRY_DELAY_MS * attempt);
        }
    }
};

const readJson = (response: Response): Promise<unknown> => response.json();

const requestJson = (path: string, options: RequestOptions): Promise<unknown> =>
    request(path, options, readJson);

export interface HealthReport {
    ok: boolean;
    /** Why not, in Chinese; only set when `ok` is false */
    reason?: string;
    queue?: { running: number; pending: number };
}

/**
 * Cheap pre-flight so a down box costs the user one message instead of a
 * submit-then-fail round trip.
 */
export const checkHealth = async (): Promise<HealthReport> => {
    if (!baseUrl) return { ok: false, reason: '生图服务未配置' };

    try {
        const payload = await requestJson('/health', {
            timeoutMs: HEALTH_TIMEOUT_MS,
            retries: 1,
        });
        if (typeof payload !== 'object' || payload === null) {
            return { ok: false, reason: '生图服务返回了看不懂的内容' };
        }
        const comfyui = 'comfyui' in payload ? payload.comfyui : undefined;
        if (comfyui !== 'available') {
            return { ok: false, reason: '生图服务在线，但它后面的 ComfyUI 没起来' };
        }
        const queue = 'queue' in payload ? payload.queue : undefined;
        return {
            ok: true,
            queue: typeof queue === 'object' && queue !== null
                ? { running: Number(Reflect.get(queue, 'running') ?? 0), pending: Number(Reflect.get(queue, 'pending') ?? 0) }
                : undefined,
        };
    } catch (error) {
        // Loudly: a bad pre-flight is the difference between "no picture" and
        // "no picture and no idea why"
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[comfy] health check failed: ${detail}`);
        return {
            ok: false,
            reason: error instanceof ComfyError ? error.userMessage : '连不上生图服务',
        };
    }
};

let cachedWorkflows: { at: number; workflows: ComfyWorkflow[] } | null = null;

const isWorkflow = (value: unknown): value is ComfyWorkflow =>
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'id') === 'string' &&
    typeof Reflect.get(value, 'kind') === 'string';

/**
 * The available workflows, as the server declares them. Cached briefly so a
 * burst of commands doesn't re-ask, and never throws: an unreachable list
 * degrades to the two known ids rather than blocking generation.
 */
export const listWorkflows = async (): Promise<ComfyWorkflow[]> => {
    if (cachedWorkflows && Date.now() - cachedWorkflows.at < WORKFLOWS_TTL_MS) {
        return cachedWorkflows.workflows;
    }

    try {
        const payload = await requestJson('/v1/workflows', {
            timeoutMs: POLL_TIMEOUT_MS,
            retries: 1,
        });
        const raw =
            typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'workflows') : null;
        const workflows = Array.isArray(raw) ? raw.filter(isWorkflow) : [];
        if (workflows.length === 0) throw new Error('empty workflow list');
        cachedWorkflows = { at: Date.now(), workflows };
        return workflows;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[comfy] could not list workflows (${reason}), using the built-in list`);
        return FALLBACK_WORKFLOWS;
    }
};

/** Drop the cache, so tests (and a restarted backend) see a fresh list */
export const forgetWorkflows = (): void => {
    cachedWorkflows = null;
};

/** Submit a job; returns its id. */
export const submitGeneration = async (body: GenerationRequest): Promise<string> => {
    const payload = await requestJson('/v1/generations', {
        method: 'POST',
        body,
        timeoutMs: SUBMIT_TIMEOUT_MS,
        // A submit lost to a dropped connection means the user gets nothing at
        // all; the worst a retry can do is queue the picture twice
        retries: 1,
    });
    const id = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'id') : null;
    if (typeof id !== 'string' || !id) {
        throw new ComfyError('生图服务没有返回任务号', 'POST /v1/generations returned no id');
    }
    return id;
};

const isStatus = (value: unknown): value is GenerationStatus =>
    value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed';

/** One poll of a job's state. */
export const fetchGeneration = async (id: string): Promise<GenerationJob> => {
    const payload = await requestJson(`/v1/generations/${id}`, { timeoutMs: POLL_TIMEOUT_MS });
    if (typeof payload !== 'object' || payload === null) {
        throw new ComfyError('生图服务返回了看不懂的内容', 'malformed job payload', true);
    }

    const status = Reflect.get(payload, 'status');
    if (!isStatus(status)) {
        throw new ComfyError('生图服务返回了未知的任务状态', `status: ${String(status)}`, true);
    }

    const rawImages = Reflect.get(payload, 'images');
    const images: GeneratedImageRef[] = Array.isArray(rawImages)
        ? rawImages.flatMap((image: unknown, fallbackIndex) => {
            if (typeof image !== 'object' || image === null) return [];
            const index = Reflect.get(image, 'index');
            const filename = Reflect.get(image, 'filename');
            const url = Reflect.get(image, 'url');
            return [{
                index: typeof index === 'number' ? index : fallbackIndex,
                filename: typeof filename === 'string' ? filename : `image-${fallbackIndex}.png`,
                url: typeof url === 'string' ? url : '',
            }];
        })
        : [];

    const error = Reflect.get(payload, 'error');

    return {
        id,
        status,
        images,
        error: typeof error === 'string' ? error : undefined,
    };
};

/** Download one finished image. */
export const downloadImage = async (id: string, index: number): Promise<Buffer> => {
    const startedAt = Date.now();
    const bytes = await request(
        `/v1/generations/${id}/images/${index}`,
        {
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
            // The picture already exists on the far side — never lose it to a blip
            retries: 2,
        },
        async (response) => Buffer.from(await response.arrayBuffer())
    );

    // The link to this box is the slowest part of the whole flow; keep it visible
    const seconds = (Date.now() - startedAt) / 1000;
    console.log(
        `[comfy] downloaded image ${index} of ${id}: ${Math.round(bytes.length / 1024)} KiB in ${seconds.toFixed(1)}s`
    );
    return bytes;
};
