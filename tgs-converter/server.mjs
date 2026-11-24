/**
 * tgs-converter: HTTP media helpers around rlottie, ffmpeg, and Pillow.
 *
 * Endpoints:
 *   POST /convert          body = raw .tgs bytes          -> video/webm
 *   POST /still            body = raw .tgs bytes          -> image/png
 *                          ?frame=<n|auto>  one frame; auto = mid-animation.
 *                          Fallback for documents too heavy for a full clip.
 *   POST /normalize-video  body = raw video bytes         -> original or video/mp4
 *                          ?format=mp4 also re-encodes clips that need no padding
 *                          (for a model that rejects webm/mkv containers)
 *                          ?mime=<input mime>  input container hint
 *                          image/gif input is always re-encoded to mp4: a GIF
 *                          handed to a model as an image only ever shows one
 *                          frame, as a video part it shows the motion
 *   POST /frame            body = raw video bytes          -> image/png|image/jpeg
 *                          ?mime=video/mp4|video/webm  input container hint
 *                          First frame of an animation, used as a still when
 *                          a tool needs a picture instead of a clip.
 *   POST /crop             body = raw image bytes           -> image/jpeg|image/png
 *                          ?x1&y1&x2&y2&unit=norm1000|px  region to crop
 *                          ?format=jpeg|png&max_edge=<256-1536>&scale=<1-4>
 *                          Crop one region and hand it back magnified; the
 *                          source dimensions and the box actually used ride
 *                          the response headers.
 *   POST /frames           body = raw video bytes OR ?url=<signed https URL>
 *                          ?mime=&mode=times|uniform|first|last
 *                          ?times=<comma seconds> / ?count=&start=&end=
 *                          ?size=512|768|960|1280&format=jpeg|png
 *                          Several stills of a clip as JSON {duration, frames:[…]};
 *                          a signed GCS URL lets ffmpeg read a >20MB video
 *                          remotely, so the bot never downloads it.
 *   POST /emoji-preview    body = raw emoji media bytes   -> image/png
 *   POST /emoji-atlas      body = JSON image items        -> image/png
 *   GET  /health                                          -> text/plain
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, stat, opendir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const positiveIntegerEnv = (name, fallback, maximum) => {
    const parsed = Number(process.env[name]);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
    return maximum === undefined ? parsed : Math.min(parsed, maximum);
};

const nonNegativeIntegerEnv = (name, fallback, maximum) => {
    const parsed = Number(process.env[name]);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
    return maximum === undefined ? parsed : Math.min(parsed, maximum);
};

const PORT = positiveIntegerEnv('PORT', 8080, 65535);
const CONVERT_SCRIPT = process.env.CONVERT_SCRIPT || 'lottie_to_webm.sh';
const MAX_INPUT_BYTES = positiveIntegerEnv('MAX_INPUT_BYTES', 5 * 1024 * 1024, 10 * 1024 * 1024);
const CONVERT_TIMEOUT_MS = positiveIntegerEnv('CONVERT_TIMEOUT_MS', 30000, 60000);
const CACHE_MAX_ENTRIES = positiveIntegerEnv('CACHE_MAX_ENTRIES', 200, 1000);
const CACHE_MAX_BYTES = positiveIntegerEnv('CACHE_MAX_BYTES', 64 * 1024 * 1024, 128 * 1024 * 1024);
const MAX_PROCESS_OUTPUT_BYTES = positiveIntegerEnv('MAX_PROCESS_OUTPUT_BYTES', 1024 * 1024, 4 * 1024 * 1024);
const MAX_CONVERT_OUTPUT_BYTES = positiveIntegerEnv('MAX_CONVERT_OUTPUT_BYTES', 20 * 1024 * 1024, 32 * 1024 * 1024);
const MAX_JOB_TEMP_BYTES = positiveIntegerEnv('MAX_JOB_TEMP_BYTES', 128 * 1024 * 1024, 160 * 1024 * 1024);
const JOB_SIZE_CHECK_INTERVAL_MS = 50;
const PROCESS_REAP_TIMEOUT_MS = 5000;
const EXPENSIVE_QUEUE_TIMEOUT_MS = positiveIntegerEnv('EXPENSIVE_QUEUE_TIMEOUT_MS', 10000, 30000);
const REQUEST_BODY_TIMEOUT_MS = positiveIntegerEnv('REQUEST_BODY_TIMEOUT_MS', 30000, 60000);

const MIN_VIDEO_SECONDS = positiveIntegerEnv('MIN_VIDEO_SECONDS', 1, 5);
const NORMALIZE_MAX_INPUT_BYTES = positiveIntegerEnv('NORMALIZE_MAX_INPUT_BYTES', 20 * 1024 * 1024, 32 * 1024 * 1024);
const NORMALIZE_TIMEOUT_MS = positiveIntegerEnv('NORMALIZE_TIMEOUT_MS', 30000, 60000);

const FRAME_MAX_INPUT_BYTES = positiveIntegerEnv('FRAME_MAX_INPUT_BYTES', 20 * 1024 * 1024, 32 * 1024 * 1024);
const FRAME_TIMEOUT_MS = positiveIntegerEnv('FRAME_TIMEOUT_MS', 15000, 30000);
const FRAME_MAX_OUTPUT_BYTES = positiveIntegerEnv('FRAME_MAX_OUTPUT_BYTES', 6 * 1024 * 1024, 12 * 1024 * 1024);
/** Longest side of the still; animations are 320 and stickers 512, so this only trims odd large inputs */
const MAX_FRAME_DIMENSION = 1280;
const FRAME_VIDEO_MIMES = new Set(['video/mp4', 'video/webm']);

/** Crop one region of a picture; the bot sends the bytes it already holds */
const CROP_MAX_INPUT_BYTES = positiveIntegerEnv('CROP_MAX_INPUT_BYTES', 20 * 1024 * 1024, 32 * 1024 * 1024);
const CROP_TIMEOUT_MS = positiveIntegerEnv('CROP_TIMEOUT_MS', 15000, 30000);
const CROP_MAX_OUTPUT_BYTES = positiveIntegerEnv('CROP_MAX_OUTPUT_BYTES', 2 * 1024 * 1024, 4 * 1024 * 1024);
const CROP_MIN_SHORT_EDGE = 48;
const CROP_MIN_MAX_EDGE = 256;
const CROP_MAX_MAX_EDGE = 1536;
const CROP_DEFAULT_MAX_EDGE = 1536;
/** A crop smaller than this is scaled up to fill the model's image budget */
const CROP_UPSCALE_LONG_EDGE = 1024;
/** Guard against a decompression bomb, not against a normal 20MP photo */
const CROP_MAX_PIXELS = 64 * 1024 * 1024;

/** Several stills of a clip; a signed URL lets ffmpeg read a large video remotely */
const FRAMES_MAX_INPUT_BYTES = positiveIntegerEnv('FRAMES_MAX_INPUT_BYTES', 20 * 1024 * 1024, 32 * 1024 * 1024);
const FRAMES_TIMEOUT_MS = positiveIntegerEnv('FRAMES_TIMEOUT_MS', 30000, 60000);
const FRAMES_REMOTE_TIMEOUT_MS = positiveIntegerEnv('FRAMES_REMOTE_TIMEOUT_MS', 60000, 120000);
const FRAMES_MAX_OUTPUT_BYTES = positiveIntegerEnv('FRAMES_MAX_OUTPUT_BYTES', 8 * 1024 * 1024, 16 * 1024 * 1024);
const FRAMES_SINGLE_MAX_BYTES = positiveIntegerEnv('FRAMES_SINGLE_MAX_BYTES', 2 * 1024 * 1024, 4 * 1024 * 1024);
const FRAMES_SINGLE_TIMEOUT_MS = positiveIntegerEnv('FRAMES_SINGLE_TIMEOUT_MS', 8000, 20000);
const FRAMES_REMOTE_SINGLE_TIMEOUT_MS = positiveIntegerEnv('FRAMES_REMOTE_SINGLE_TIMEOUT_MS', 20000, 30000);
const FRAMES_MAX_COUNT = 6;
const FRAMES_MAX_REMOTE_INPUT_BYTES = positiveIntegerEnv('FRAMES_REMOTE_MAX_INPUT_BYTES', 300 * 1024 * 1024, 320 * 1024 * 1024);
const FRAMES_DEFAULT_SIZE = 960;
const FRAMES_SIZES = new Set([512, 768, 960, 1280]);
const FRAMES_REMOTE_HOSTS = new Set(['storage.googleapis.com']);
const FRAMES_MAX_REDIRECTS = positiveIntegerEnv('FRAMES_MAX_REDIRECTS', 1, 4);

const EMOJI_MAX_INPUT_BYTES = positiveIntegerEnv('EMOJI_MAX_INPUT_BYTES', 10 * 1024 * 1024, 12 * 1024 * 1024);
const EMOJI_TIMEOUT_MS = positiveIntegerEnv('EMOJI_TIMEOUT_MS', 30000, 60000);
const EMOJI_PREVIEW_SIZE = 512;
const ATLAS_MAX_ITEMS = 8;
const ATLAS_MAX_BODY_BYTES = positiveIntegerEnv('ATLAS_MAX_BODY_BYTES', 12 * 1024 * 1024, 16 * 1024 * 1024);
const ATLAS_MAX_IMAGE_BYTES = positiveIntegerEnv('ATLAS_MAX_IMAGE_BYTES', 2 * 1024 * 1024, 2 * 1024 * 1024);
const ATLAS_MAX_OUTPUT_BYTES = 512 * 1024;
const EMOJI_PREVIEW_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1024;
const MAX_IMAGE_PIXELS = 1024 * 1024;
const MAX_TGS_JSON_BYTES = 1024 * 1024;
const MAX_TGS_DIMENSION = 512;
const MAX_TGS_DURATION_SECONDS = 3;
const MAX_TGS_FRAME_RATE = 60;
const MAX_TGS_FRAMES = 180;
/** Full-clip renders are cached per sticker, so a heavy document is paid once */
const MAX_TGS_JSON_NODES = positiveIntegerEnv('MAX_TGS_JSON_NODES', 80000, 200000);
/** A single frame costs a fraction of a clip; allow heavier documents for stills */
const MAX_TGS_STILL_JSON_NODES = positiveIntegerEnv('MAX_TGS_STILL_JSON_NODES', 200000, 400000);
const STILL_TIMEOUT_MS = positiveIntegerEnv('STILL_TIMEOUT_MS', 5000, 30000);
const STILL_MAX_OUTPUT_BYTES = positiveIntegerEnv('STILL_MAX_OUTPUT_BYTES', 1024 * 1024, 2 * 1024 * 1024);
const MAX_EMOJI_DURATION_SECONDS = 5;
const MAX_WEBM_FRAME_RATE = 60;
const MAX_NORMALIZE_DIMENSION = 4096;
const MAX_NORMALIZE_PIXELS = 16 * 1024 * 1024;
const MAX_NORMALIZE_DURATION_SECONDS = 6 * 60 * 60;
/** An animation is watched, not archived: 30s is plenty for a meme */
const MAX_ANIMATION_SECONDS = 30;
const MAX_NORMALIZE_FRAME_RATE = 240;
const MAX_NORMALIZE_STREAMS = 8;
const NORMALIZE_VIDEO_MIMES = new Set([
    'video/mp4', 'video/mpeg', 'video/mov', 'video/quicktime', 'video/avi',
    'video/x-msvideo', 'video/x-flv', 'video/mpg', 'video/mpegps',
    'video/webm', 'video/wmv', 'video/x-ms-wmv', 'video/3gpp',
    // Animated images: only useful to a model as a video part (see below)
    'image/gif',
]);
const MAX_EXPENSIVE_PROCESSES = positiveIntegerEnv('MAX_EXPENSIVE_PROCESSES', 3, 8);
const MAX_EXPENSIVE_QUEUE = nonNegativeIntegerEnv('MAX_EXPENSIVE_QUEUE', 32, 128);
const gunzipAsync = promisify(gunzip);

class HttpError extends Error {
    constructor(statusCode, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.details = details;
    }
}

/** @type {Map<string, { value: unknown, sizeBytes: number }>} */
const cache = new Map();
let cacheBytes = 0;

const cacheValueSize = (value) => {
    if (Buffer.isBuffer(value)) return value.length;
    if (value && typeof value === 'object' && Buffer.isBuffer(value.data)) {
        return value.data.length;
    }
    return 0;
};

const cacheGet = (key) => {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
};

const cacheSet = (key, value) => {
    const sizeBytes = cacheValueSize(value);
    const existing = cache.get(key);
    if (existing) cacheBytes -= existing.sizeBytes;
    cache.delete(key);
    if (sizeBytes > CACHE_MAX_BYTES) return;
    cache.set(key, { value, sizeBytes });
    cacheBytes += sizeBytes;
    while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        const evicted = cache.get(oldest);
        cache.delete(oldest);
        if (evicted) cacheBytes -= evicted.sizeBytes;
    }
};

let activeExpensiveProcesses = 0;
const expensiveProcessQueue = [];

const removeQueuedPermit = (waiter) => {
    const index = expensiveProcessQueue.indexOf(waiter);
    if (index >= 0) expensiveProcessQueue.splice(index, 1);
};

const acquireExpensivePermit = (signal) => {
    if (signal.aborted) throw new HttpError(499, 'client disconnected');
    if (activeExpensiveProcesses < MAX_EXPENSIVE_PROCESSES) {
        activeExpensiveProcesses += 1;
        return Promise.resolve();
    }
    if (expensiveProcessQueue.length >= MAX_EXPENSIVE_QUEUE) {
        throw new HttpError(503, 'expensive process queue is full');
    }
    return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, timer: undefined, onAbort: undefined };
        const cleanup = () => {
            if (waiter.timer) clearTimeout(waiter.timer);
            if (waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort);
        };
        waiter.onAbort = () => {
            removeQueuedPermit(waiter);
            cleanup();
            reject(new HttpError(499, 'client disconnected while queued'));
        };
        waiter.timer = setTimeout(() => {
            removeQueuedPermit(waiter);
            cleanup();
            reject(new HttpError(503, 'expensive process queue wait timed out'));
        }, EXPENSIVE_QUEUE_TIMEOUT_MS);
        expensiveProcessQueue.push(waiter);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
        if (signal.aborted) waiter.onAbort();
    });
};

const releaseExpensivePermit = () => {
    for (;;) {
        const next = expensiveProcessQueue.shift();
        if (!next) {
            activeExpensiveProcesses -= 1;
            return;
        }
        if (next.timer) clearTimeout(next.timer);
        if (next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
        if (next.signal.aborted) continue;
        next.resolve();
        return;
    }
};

const withExpensivePermit = async (operation, signal) => {
    await acquireExpensivePermit(signal);
    try {
        if (signal.aborted) throw new HttpError(499, 'client disconnected');
        return await operation();
    } finally {
        releaseExpensivePermit();
    }
};

const withExpensiveRequest = async (req, res, operation) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('client disconnected'));
    req.once('aborted', abort);
    res.once('close', abort);
    try {
        return await withExpensivePermit(() => operation(controller.signal), controller.signal);
    } finally {
        req.removeListener('aborted', abort);
        res.removeListener('close', abort);
    }
};

const readBody = (req, maxBytes = MAX_INPUT_BYTES, signal) =>
    new Promise((resolve, reject) => {
        const declaredLength = Number(req.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            req.resume();
            reject(new HttpError(413, `input too large (> ${maxBytes} bytes)`));
            return;
        }
        const chunks = [];
        let size = 0;
        let settled = false;
        let timer;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            req.removeListener('data', onData);
            req.removeListener('end', onEnd);
            req.removeListener('error', onError);
            req.removeListener('aborted', onAborted);
            signal?.removeEventListener('abort', onAborted);
        };
        const finish = (error, body) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(body);
        };
        const onData = (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                req.resume();
                finish(new HttpError(413, `input too large (> ${maxBytes} bytes)`));
                return;
            }
            chunks.push(chunk);
        };
        const onEnd = () => finish(undefined, Buffer.concat(chunks));
        const onError = (error) => finish(error);
        const onAborted = () => finish(new HttpError(499, 'request body aborted'));
        req.on('data', onData);
        req.once('end', onEnd);
        req.once('error', onError);
        req.once('aborted', onAborted);
        signal?.addEventListener('abort', onAborted, { once: true });
        timer = setTimeout(
            () => finish(new HttpError(408, 'request body timed out')),
            REQUEST_BODY_TIMEOUT_MS
        );
        if (signal?.aborted) onAborted();
    });

const killProcessGroup = (proc) => {
    try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
    } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('ESRCH')) {
            console.error('[tgs-converter] failed to kill process group:', error);
        }
    }
};

const directorySizeBytes = async (directoryPath) => {
    let total = 0;
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
        const entryPath = join(directoryPath, entry.name);
        if (entry.isDirectory()) total += await directorySizeBytes(entryPath);
        else if (entry.isFile()) total += (await stat(entryPath)).size;
        if (total > MAX_JOB_TEMP_BYTES) return total;
    }
    return total;
};

const runProcess = (command, args, timeoutMs, timeoutMessage, options = {}) =>
    new Promise((resolve, reject) => {
        const maxFileBytes = Math.min(
            options.maxFileBytes ?? MAX_JOB_TEMP_BYTES,
            MAX_JOB_TEMP_BYTES
        );
        const fileSizeBlocks = Math.max(1, Math.ceil(maxFileBytes / 512));
        const proc = spawn('/bin/sh', [
            '-c',
            'limit="$1"; shift; ulimit -f "$limit"; exec "$@"',
            'process-limit',
            String(fileSizeBlocks),
            command,
            ...args,
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
            env: options.jobDirectory
                ? { ...process.env, TMPDIR: options.jobDirectory }
                : process.env,
        });
        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let settled = false;
        let terminatingError;
        let timeoutTimer;
        let reapTimer;
        let sizeTimer;
        let sizeCheckRunning = false;
        const signal = options.signal;
        const cleanup = () => {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (reapTimer) clearTimeout(reapTimer);
            if (sizeTimer) clearInterval(sizeTimer);
            signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve({ stdout, stderr });
        };
        const requestTermination = (error) => {
            if (terminatingError || settled) return;
            terminatingError = error;
            killProcessGroup(proc);
            reapTimer = setTimeout(() => finish(terminatingError), PROCESS_REAP_TIMEOUT_MS);
        };
        const onAbort = () => requestTermination(new HttpError(499, 'client disconnected'));
        const appendOutput = (target, data) => {
            outputBytes += data.length;
            if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
                requestTermination(new Error(`${command} output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes`));
                return target;
            }
            return target + data.toString();
        };
        proc.stdout.on('data', (data) => { stdout = appendOutput(stdout, data); });
        proc.stderr.on('data', (data) => { stderr = appendOutput(stderr, data); });
        timeoutTimer = setTimeout(
            () => requestTermination(new Error(timeoutMessage)),
            timeoutMs
        );
        if (options.jobDirectory) {
            sizeTimer = setInterval(() => {
                if (sizeCheckRunning || terminatingError || settled) return;
                sizeCheckRunning = true;
                void directorySizeBytes(options.jobDirectory)
                    .then((sizeBytes) => {
                        if (sizeBytes > MAX_JOB_TEMP_BYTES) {
                            requestTermination(new Error(`job temporary data exceeded ${MAX_JOB_TEMP_BYTES} bytes`));
                        }
                    })
                    .catch((error) => {
                        if (!settled && !terminatingError && error?.code !== 'ENOENT') {
                            requestTermination(error);
                        }
                    })
                    .finally(() => { sizeCheckRunning = false; });
            }, JOB_SIZE_CHECK_INTERVAL_MS);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        proc.on('error', finish);
        proc.on('close', (code) => {
            if (terminatingError) {
                finish(terminatingError);
                return;
            }
            if (code === 0) finish();
            else finish(new Error(`${command} exited ${code}: ${stderr.slice(0, 500)}`));
        });
        if (signal?.aborted) onAbort();
    });

const convertTgsToWebm = async (tgsBuffer, signal) => {
    const dir = await mkdtemp(join(tmpdir(), 'tgs-'));
    const inPath = join(dir, 'in.tgs');
    const outPath = join(dir, 'out.webm');
    try {
        await writeFile(inPath, tgsBuffer);
        await runProcess(
            CONVERT_SCRIPT,
            ['--output', outPath, inPath],
            CONVERT_TIMEOUT_MS,
            'conversion timed out',
            { jobDirectory: dir, maxFileBytes: MAX_CONVERT_OUTPUT_BYTES, signal }
        );
        const outputInfo = await stat(outPath);
        if (outputInfo.size > MAX_CONVERT_OUTPUT_BYTES) {
            throw new HttpError(500, `conversion output exceeds ${MAX_CONVERT_OUTPUT_BYTES} bytes`);
        }
        return readFile(outPath);
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

const stillFrameOf = (animation, requested) => {
    const firstFrame = Number(animation.ip);
    const lastFrame = Number(animation.op);
    if (requested === null || requested === 'auto') {
        return Math.floor((firstFrame + lastFrame) / 2);
    }
    if (!/^\d+$/.test(requested)) {
        throw new HttpError(400, 'frame must be a non-negative integer or auto');
    }
    const frame = Number(requested);
    if (frame < firstFrame || frame > lastFrame - 1) {
        throw new HttpError(422, `frame must be within ${firstFrame}-${Math.ceil(lastFrame) - 1}`);
    }
    return frame;
};

/**
 * One rendered frame of a .tgs as PNG. Used when the document is too heavy for
 * a full clip (or the clip render failed): a still beats "you cannot see it".
 */
const renderTgsStill = async (tgsBuffer, frame, signal) => {
    const dir = await mkdtemp(join(tmpdir(), 'tgs-still-'));
    const inPath = join(dir, 'in.tgs');
    const outPath = join(dir, 'out.png');
    try {
        await writeFile(inPath, tgsBuffer);
        await runProcess(
            process.env.STILL_SCRIPT || 'lottie_convert.py',
            ['--frame', String(frame), inPath, outPath],
            STILL_TIMEOUT_MS,
            'still render timed out',
            { jobDirectory: dir, maxFileBytes: STILL_MAX_OUTPUT_BYTES, signal }
        );
        const outputInfo = await stat(outPath);
        if (outputInfo.size === 0) {
            throw new HttpError(500, 'still render produced no data');
        }
        if (outputInfo.size > STILL_MAX_OUTPUT_BYTES) {
            throw new HttpError(500, `still output exceeds ${STILL_MAX_OUTPUT_BYTES} bytes`);
        }
        const still = await readFile(outPath);
        if (!hasMagic(still, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
            throw new HttpError(500, 'still output is not a PNG');
        }
        return still;
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

const probeVideoDuration = async (filePath, jobDirectory, signal) => {
    const { stdout } = await runProcess('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        filePath,
    ], EMOJI_TIMEOUT_MS, 'ffprobe timed out', {
        jobDirectory,
        maxFileBytes: MAX_PROCESS_OUTPUT_BYTES,
        signal,
    });
    const duration = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(duration)) throw new Error('ffprobe returned no duration');
    return duration;
};

/**
 * @param {object} [options]
 * @param {boolean} [options.forceMp4] caller needs H.264/MP4 even when the clip
 *   already lasts >= MIN_VIDEO_SECONDS (a model that rejects webm/mkv), so the
 *   pass-through shortcut is skipped.
 */
const normalizeShortVideo = async (videoBuffer, inputMime, signal, options = {}) => {
    if (!NORMALIZE_VIDEO_MIMES.has(inputMime)) {
        throw new HttpError(415, `unsupported video MIME: ${inputMime}`);
    }
    const forceMp4 = options.forceMp4 === true;
    const isAnimation = inputMime === 'image/gif';
    const dir = await mkdtemp(join(tmpdir(), 'normalize-'));
    const inPath = join(dir, 'input.bin');
    const outPath = join(dir, 'output.mp4');
    try {
        await writeFile(inPath, videoBuffer);
        const videoInfo = await probeNormalizeVideo(inPath, dir, signal, {
            allowUnknownDuration: isAnimation,
        });
        const needsPadding =
            videoInfo.duration !== undefined && videoInfo.duration < MIN_VIDEO_SECONDS;
        if (!forceMp4 && !needsPadding) {
            return { data: videoBuffer, mimeType: inputMime, normalized: false };
        }
        // Ultra-short clips are looped up to MIN_VIDEO_SECONDS; a normal-length
        // clip is re-encoded as-is (only reached with forceMp4). A GIF with no
        // duration is capped instead, so a long loop cannot run unbounded.
        const inputArgs = needsPadding
            ? ['-stream_loop', '-1', '-i', inPath, '-t', String(MIN_VIDEO_SECONDS)]
            : isAnimation
              ? ['-i', inPath, '-t', String(MAX_ANIMATION_SECONDS)]
              : ['-i', inPath];
        await runProcess('ffmpeg', [
            '-y',
            '-threads', '2',
            ...inputArgs,
            '-c:v', 'libx264',
            // yuv420p needs even dimensions, and GIFs are often odd-sized
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-preset', 'ultrafast',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            outPath,
        ], NORMALIZE_TIMEOUT_MS, 'normalize timed out', {
            jobDirectory: dir,
            maxFileBytes: MAX_CONVERT_OUTPUT_BYTES,
            signal,
        });
        const outputInfo = await stat(outPath);
        if (outputInfo.size > MAX_CONVERT_OUTPUT_BYTES) {
            throw new HttpError(500, `normalized output exceeds ${MAX_CONVERT_OUTPUT_BYTES} bytes`);
        }
        return { data: await readFile(outPath), mimeType: 'video/mp4', normalized: true };
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

/**
 * First frame of an animation as a still image. The bytes are local (media
 * cache), so this only decodes. A JPEG keeps a video frame small; webm
 * stickers may carry alpha, so they stay PNG.
 */
const extractFirstFrame = async (videoBuffer, inputMime, format, signal) => {
    if (!FRAME_VIDEO_MIMES.has(inputMime)) {
        throw new HttpError(415, `unsupported video MIME: ${inputMime}`);
    }
    const dir = await mkdtemp(join(tmpdir(), 'frame-'));
    const inPath = join(dir, 'input.bin');
    const outPath = join(dir, format === 'jpeg' ? 'frame.jpg' : 'frame.png');
    try {
        await writeFile(inPath, videoBuffer);
        await runProcess('ffmpeg', [
            '-y',
            '-threads', '2',
            '-i', inPath,
            '-frames:v', '1',
            // Quotes are part of the filter expression (no shell here)
            '-vf', `scale='min(${MAX_FRAME_DIMENSION},iw)':-2`,
            ...(format === 'jpeg' ? ['-q:v', '2'] : []),
            outPath,
        ], FRAME_TIMEOUT_MS, 'frame extraction timed out', {
            jobDirectory: dir,
            maxFileBytes: FRAME_MAX_OUTPUT_BYTES,
            signal,
        });
        const outputInfo = await stat(outPath);
        if (outputInfo.size === 0) {
            throw new HttpError(500, 'frame extraction produced no data');
        }
        if (outputInfo.size > FRAME_MAX_OUTPUT_BYTES) {
            throw new HttpError(500, `frame output exceeds ${FRAME_MAX_OUTPUT_BYTES} bytes`);
        }
        return readFile(outPath);
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

/**
 * The still format the bytes actually are; the bot sends the same bytes the
 * model saw, so the MIME it carries is not trusted here.
 */
const sniffStillByteFormat = (buffer) => {
    if (hasMagic(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (hasMagic(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
    if (buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null;
};

/** Width/height of a JPEG or PNG we just encoded, without another decoder */
const stillImageSizeOf = (buffer) => {
    const png = hasMagic(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (png && buffer.length >= 24) {
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return width > 0 && height > 0 ? { width, height } : null;
    }
    if (hasMagic(buffer, [0xff, 0xd8, 0xff])) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) { offset += 1; continue; }
            const marker = buffer[offset + 1];
            if (marker === 0xd8 || marker === 0x01 || marker === 0xda) break;
            const length = buffer.readUInt16BE(offset + 2);
            if (length < 2) break;
            const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isSof) {
                const height = buffer.readUInt16BE(offset + 5);
                const width = buffer.readUInt16BE(offset + 7);
                return width > 0 && height > 0 ? { width, height } : null;
            }
            offset += 2 + length;
        }
    }
    return null;
};

/**
 * Crop + magnify one region with Pillow. The picture comes from the model's
 * context, so this is local work: no queue slot, only the process timeout.
 * The script answers JSON on stdout (ok/error + the box it actually used), and
 * Node turns a validation failure into a 422 the model can fix by itself.
 */
const CROP_PYTHON = String.raw`
import json
import sys
import warnings
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 64 * 1024 * 1024
warnings.simplefilter('error', Image.DecompressionBombWarning)

(in_path, out_path, unit, x1_text, y1_text, x2_text, y2_text,
 requested_format, max_edge_text, scale_text, max_bytes_text) = sys.argv[1:12]

max_edge = int(max_edge_text)
max_bytes = int(max_bytes_text)
scale = None if scale_text == '' else float(scale_text)

def answer(payload):
    print(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
    sys.exit(0)

def fail(message, width=None, height=None):
    payload = {'ok': False, 'error': message}
    if width is not None and height is not None:
        payload['width'] = width
        payload['height'] = height
    answer(payload)

try:
    with Image.open(in_path) as source:
        source_format = (source.format or '').upper()
        raw_width, raw_height = source.size
        if raw_width <= 0 or raw_height <= 0:
            fail('image has no usable size')
        if raw_width * raw_height > Image.MAX_IMAGE_PIXELS:
            fail('image is too large to crop', raw_width, raw_height)
        # Coordinates refer to the picture as a viewer sees it: rotate by EXIF first
        image = ImageOps.exif_transpose(source)
        image.load()
        if image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info):
            rgba = image.convert('RGBA')
            background = Image.new('RGB', rgba.size, 'white')
            background.paste(rgba, mask=rgba.getchannel('A'))
            image = background
        else:
            image = image.convert('RGB')
        width, height = image.size
        if width <= 0 or height <= 0:
            fail('image has no usable size')
        if width * height > Image.MAX_IMAGE_PIXELS:
            fail('image is too large to crop', width, height)
except Exception as error:
    fail('cannot read the image: ' + str(error))
    raise SystemExit(0)

flags = []
try:
    x1 = float(x1_text)
    y1 = float(y1_text)
    x2 = float(x2_text)
    y2 = float(y2_text)
except ValueError:
    fail('crop box must be four numbers', width, height)

if unit == 'norm1000':
    px1 = x1 / 1000.0 * width
    py1 = y1 / 1000.0 * height
    px2 = x2 / 1000.0 * width
    py2 = y2 / 1000.0 * height
else:
    px1, py1, px2, py2 = x1, y1, x2, y2

if px2 <= px1 or py2 <= py1:
    if px2 < px1:
        px1, px2 = px2, px1
    if py2 < py1:
        py1, py2 = py2, py1
    flags.append('swapped')

clamped_x1 = max(0, min(width, int(round(px1))))
clamped_y1 = max(0, min(height, int(round(py1))))
clamped_x2 = max(0, min(width, int(round(px2))))
clamped_y2 = max(0, min(height, int(round(py2))))
if (clamped_x1, clamped_y1, clamped_x2, clamped_y2) != (int(round(px1)), int(round(py1)), int(round(px2)), int(round(py2))):
    flags.append('clamped')

crop_width = clamped_x2 - clamped_x1
crop_height = clamped_y2 - clamped_y1
if crop_width < 48 or crop_height < 48:
    fail('crop is too small', width, height)

cropped = image.crop((clamped_x1, clamped_y1, clamped_x2, clamped_y2))
long_edge = max(crop_width, crop_height)
if scale is not None:
    desired = int(round(long_edge * scale))
else:
    desired = max(1024, long_edge)
target_long_edge = min(max_edge, max(256, desired))
if target_long_edge != long_edge:
    ratio = target_long_edge / long_edge
    resized = (max(1, int(round(crop_width * ratio))), max(1, int(round(crop_height * ratio))))
    cropped = cropped.resize(resized, getattr(Image, 'Resampling', Image).LANCZOS)
    flags.append('upscaled' if ratio > 1 else 'downscaled')

if requested_format == 'auto':
    final_format = 'jpeg' if source_format not in ('PNG', 'WEBP') else 'png'
else:
    final_format = requested_format

def save_as(fmt, path, quality=None):
    if fmt == 'png':
        cropped.save(path, 'PNG', optimize=True)
    else:
        cropped.save(path, 'JPEG', quality=quality or 90, subsampling=0, optimize=True)

save_as(final_format, out_path)
import os
if os.path.getsize(out_path) > max_bytes and final_format == 'png':
    final_format = 'jpeg'
    flags.append('jpeg-fallback')
    save_as('jpeg', out_path, 90)
if os.path.getsize(out_path) > max_bytes:
    for quality in (82, 74, 66):
        final_format = 'jpeg'
        save_as('jpeg', out_path, quality)
        if os.path.getsize(out_path) <= max_bytes:
            break
if os.path.getsize(out_path) > max_bytes:
    fail('cropped output is too large')

answer({
    'ok': True,
    'width': width,
    'height': height,
    'x1': clamped_x1,
    'y1': clamped_y1,
    'x2': clamped_x2,
    'y2': clamped_y2,
    'outputWidth': cropped.width,
    'outputHeight': cropped.height,
    'format': final_format,
    'flags': flags,
})
`;

const parseCropQuery = (searchParams) => {
    const parseNumber = (name) => {
        const raw = searchParams.get(name);
        const value = raw === null ? Number.NaN : Number(raw);
        if (!Number.isFinite(value)) throw new HttpError(400, `${name} must be a number`);
        return value;
    };
    const unit = searchParams.get('unit') ?? 'norm1000';
    if (unit !== 'norm1000' && unit !== 'px') throw new HttpError(400, 'unit must be norm1000 or px');
    const requestedFormat = searchParams.get('format');
    if (requestedFormat !== null && requestedFormat !== 'jpeg' && requestedFormat !== 'png') {
        throw new HttpError(400, 'format must be jpeg or png');
    }
    const maxEdgeRaw = searchParams.get('max_edge');
    const maxEdge = maxEdgeRaw === null ? CROP_DEFAULT_MAX_EDGE : Number(maxEdgeRaw);
    if (!Number.isSafeInteger(maxEdge) || maxEdge < CROP_MIN_MAX_EDGE || maxEdge > CROP_MAX_MAX_EDGE) {
        throw new HttpError(400, `max_edge must be within ${CROP_MIN_MAX_EDGE}-${CROP_MAX_MAX_EDGE}`);
    }
    const scaleRaw = searchParams.get('scale');
    let scale;
    if (scaleRaw !== null && scaleRaw !== '') {
        scale = Number(scaleRaw);
        if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new HttpError(400, 'scale must be within 1-4');
    }
    return {
        unit,
        x1: parseNumber('x1'),
        y1: parseNumber('y1'),
        x2: parseNumber('x2'),
        y2: parseNumber('y2'),
        format: requestedFormat ?? 'auto',
        maxEdge,
        ...(scale === undefined ? {} : { scale }),
    };
};

const cropStillImage = async (inputBuffer, options, signal) => {
    const inputFormat = sniffStillByteFormat(inputBuffer);
    if (inputFormat === null) throw new HttpError(415, 'input is not PNG/JPEG/WebP');
    const dir = await mkdtemp(join(tmpdir(), 'crop-'));
    const inPath = join(dir, `input.${inputFormat === 'jpeg' ? 'jpg' : inputFormat}`);
    const outPath = join(dir, options.format === 'png' ? 'out.png' : 'out.jpg');
    try {
        await writeFile(inPath, inputBuffer);
        const { stdout } = await runProcess(
            process.env.PYTHON_BIN || 'python3',
            [
                '-c', CROP_PYTHON,
                inPath, outPath, options.unit,
                String(options.x1), String(options.y1), String(options.x2), String(options.y2),
                options.format, String(options.maxEdge),
                options.scale === undefined ? '' : String(options.scale),
                String(CROP_MAX_OUTPUT_BYTES),
            ],
            CROP_TIMEOUT_MS,
            'crop timed out',
            { jobDirectory: dir, maxFileBytes: CROP_MAX_OUTPUT_BYTES, signal }
        );
        let parsed;
        try {
            parsed = JSON.parse(stdout.trim());
        } catch {
            throw new HttpError(500, 'crop returned unreadable metadata');
        }
        if (parsed.ok !== true) {
            if (Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) {
                throw new HttpError(422, parsed.error || 'invalid crop box', {
                    width: parsed.width,
                    height: parsed.height,
                });
            }
            throw new HttpError(500, parsed.error || 'crop failed');
        }
        const outputInfo = await stat(outPath);
        if (outputInfo.size === 0) throw new HttpError(500, 'crop produced no data');
        if (outputInfo.size > CROP_MAX_OUTPUT_BYTES) throw new HttpError(500, 'crop output exceeds the limit');
        const data = await readFile(outPath);
        return {
            data,
            mime: parsed.format === 'png' ? 'image/png' : 'image/jpeg',
            meta: {
                sourceWidth: parsed.width,
                sourceHeight: parsed.height,
                x1: parsed.x1,
                y1: parsed.y1,
                x2: parsed.x2,
                y2: parsed.y2,
                outputWidth: parsed.outputWidth,
                outputHeight: parsed.outputHeight,
                flags: Array.isArray(parsed.flags) ? parsed.flags : [],
            },
        };
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

/** Only a signed URL for the media bucket may be read remotely: no SSRF */
const resolveRemoteVideoUrl = (searchParams) => {
    const raw = searchParams.get('url');
    if (raw === null || raw === '') return null;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new HttpError(400, 'url is not a valid absolute URL');
    }
    if (parsed.protocol !== 'https:') throw new HttpError(400, 'url must use https');
    if (!FRAMES_REMOTE_HOSTS.has(parsed.hostname)) throw new HttpError(400, 'url host is not allowed');
    return raw;
};

/**
 * Validate the /frames query into the options the extraction uses. `times`
 * and `count` are mutually exclusive; first/last override both.
 */
const parseFramesQuery = (searchParams, inputMime) => {
    if (inputMime !== 'image/gif' && !inputMime.startsWith('video/')) {
        throw new HttpError(415, `unsupported video MIME: ${inputMime || '(empty)'}`);
    }
    const modeRaw = searchParams.get('mode');
    if (modeRaw !== null && !['times', 'uniform', 'first', 'last'].includes(modeRaw)) {
        throw new HttpError(400, 'mode must be times, uniform, first or last');
    }
    const timesRaw = searchParams.get('times');
    let times = [];
    if (timesRaw !== null && timesRaw !== '') {
        times = timesRaw.split(',').map((value) => Number(value.trim()));
        if (times.length === 0 || times.length > FRAMES_MAX_COUNT) {
            throw new HttpError(400, `times must contain 1-${FRAMES_MAX_COUNT} entries`);
        }
        if (times.some((value) => !Number.isFinite(value) || value < 0)) {
            throw new HttpError(400, 'times must be non-negative numbers');
        }
    }
    const countRaw = searchParams.get('count');
    let count;
    if (countRaw !== null && countRaw !== '') {
        count = Number(countRaw);
        if (!Number.isSafeInteger(count) || count < 1 || count > FRAMES_MAX_COUNT) {
            throw new HttpError(400, `count must be within 1-${FRAMES_MAX_COUNT}`);
        }
    }
    if (times.length > 0 && count !== undefined) {
        throw new HttpError(400, 'times and count are mutually exclusive');
    }
    const mode = modeRaw ?? (times.length > 0 ? 'times' : 'uniform');
    if (mode === 'times' && times.length === 0) {
        throw new HttpError(400, 'mode=times needs times');
    }
    const startRaw = searchParams.get('start');
    const endRaw = searchParams.get('end');
    const start = startRaw === null || startRaw === '' ? undefined : Number(startRaw);
    const end = endRaw === null || endRaw === '' ? undefined : Number(endRaw);
    if (start !== undefined && (!Number.isFinite(start) || start < 0)) {
        throw new HttpError(400, 'start must be a non-negative number');
    }
    if (end !== undefined && (!Number.isFinite(end) || end < 0)) {
        throw new HttpError(400, 'end must be a non-negative number');
    }
    if (start !== undefined && end !== undefined && end <= start) {
        throw new HttpError(400, 'end must be greater than start');
    }
    const sizeRaw = searchParams.get('size');
    const size = sizeRaw === null || sizeRaw === '' ? FRAMES_DEFAULT_SIZE : Number(sizeRaw);
    if (!FRAMES_SIZES.has(size)) throw new HttpError(400, `size must be one of ${[...FRAMES_SIZES].join('/')}`);
    const formatRaw = searchParams.get('format');
    if (formatRaw !== null && formatRaw !== 'jpeg' && formatRaw !== 'png') {
        throw new HttpError(400, 'format must be jpeg or png');
    }
    return {
        mode,
        ...(times.length === 0 ? {} : { times }),
        ...(count === undefined ? {} : { count }),
        ...(start === undefined ? {} : { start }),
        ...(end === undefined ? {} : { end }),
        size,
        format: formatRaw ?? (inputMime === 'video/webm' ? 'png' : 'jpeg'),
    };
};

/** One remote read timeout for both ffprobe and each ffmpeg call */
const REMOTE_IO_TIMEOUT_US = '15000000';

const probeVideoSource = async (input, isRemote, jobDirectory, signal) => {
    const args = ['-v', 'error'];
    if (isRemote) args.push('-rw_timeout', REMOTE_IO_TIMEOUT_US);
    args.push('-show_streams', '-show_format', '-of', 'json', input);
    const { stdout } = await runProcess(
        'ffprobe',
        args,
        isRemote ? FRAMES_REMOTE_TIMEOUT_MS : FRAME_TIMEOUT_MS,
        'ffprobe timed out',
        { jobDirectory, maxFileBytes: MAX_PROCESS_OUTPUT_BYTES, signal }
    );
    let probe;
    try {
        probe = JSON.parse(stdout);
    } catch {
        throw new HttpError(422, 'invalid video: ffprobe returned unreadable output');
    }
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const video = streams.find((stream) => stream && stream.codec_type === 'video');
    if (video === undefined) throw new HttpError(415, 'input has no video stream');
    const width = Number(video.width);
    const height = Number(video.height);
    const duration = Number(video.duration ?? probe.format?.duration);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
        || width * height > 100 * 1024 * 1024) {
        throw new HttpError(422, 'video dimensions are unusable');
    }
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new HttpError(422, 'video duration is unknown or empty', { duration: null });
    }
    let rotation = 0;
    const sideData = Array.isArray(video.side_data_list) ? video.side_data_list : [];
    for (const item of sideData) {
        const value = item && item.rotation !== undefined ? Number(item.rotation) : Number.NaN;
        if (Number.isFinite(value)) rotation = value;
    }
    if (rotation === 0 && video.tags !== undefined && video.tags.rotate !== undefined) {
        const value = Number(video.tags.rotate);
        if (Number.isFinite(value)) rotation = value;
    }
    const rotated = Math.abs(Math.round(rotation)) % 180 === 90;
    return {
        duration,
        width: rotated ? height : width,
        height: rotated ? width : height,
        fps: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
        rotation,
    };
};

const frameTimesOf = (options, duration) => {
    const clamp = (value) => Math.min(Math.max(0, value), duration);
    if (options.mode === 'times') {
        for (const time of options.times) {
            if (!(time >= 0 && time < duration)) {
                throw new HttpError(422, `time ${time}s is outside the video (0-${duration}s)`, { duration });
            }
        }
        return [...options.times];
    }
    if (options.mode === 'first') return [0];
    if (options.mode === 'last') return [Math.max(0, duration - 0.15)];
    const start = clamp(options.start ?? 0);
    const end = clamp(options.end ?? duration);
    if (end - start <= 0.001) throw new HttpError(422, 'start and end leave no room for a frame', { duration });
    const count = options.count ?? 3;
    const step = (end - start) / count;
    return Array.from({ length: count }, (_, index) => start + step * (index + 0.5));
};

/**
 * The frame actually shown, relative to the requested second. Input seek
 * resets output timestamps to ~0, so `showinfo`'s pts_time is the offset past
 * the seek target, not a wall-clock position; add the request back.
 */
const actualTimeOf = (stderr, requestedT, duration) => {
    const matches = [...stderr.matchAll(/pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g)];
    const last = matches[matches.length - 1];
    const offset = last === undefined ? Number.NaN : Number(last[1]);
    if (!Number.isFinite(offset)) return requestedT;
    return Math.min(duration, requestedT + offset);
};

/**
 * Extract stills of one clip. `source` is either bytes (the media cache inline
 * path) or a signed https URL (the >20MB GCS path, where ffmpeg reads remotely
 * and the bot never downloads the file).
 */
const extractFrames = async (source, options, signal) => {
    const isRemote = source.kind === 'url';
    const dir = await mkdtemp(join(tmpdir(), 'frames-'));
    try {
        let input = source.url;
        if (source.kind === 'bytes') {
            input = join(dir, 'input.bin');
            await writeFile(input, source.data);
        }
        const probe = await probeVideoSource(input, isRemote, dir, signal);
        const times = frameTimesOf(options, probe.duration);
        const extension = options.format === 'png' ? 'png' : 'jpg';
        const mime = options.format === 'png' ? 'image/png' : 'image/jpeg';
        const frames = [];
        let totalBytes = 0;
        const startedAt = Date.now();
        for (const [index, requestedT] of times.entries()) {
            if (isRemote && Date.now() - startedAt > FRAMES_REMOTE_TIMEOUT_MS * 0.8) {
                throw new HttpError(504, 'remote video did not answer in time');
            }
            const outPath = join(dir, `frame-${index}.${extension}`);
            const args = ['-hide_banner', '-nostdin', '-y', '-threads', '2'];
            if (isRemote) args.push('-rw_timeout', REMOTE_IO_TIMEOUT_US);
            args.push(
                '-ss', requestedT.toFixed(3),
                '-i', input,
                '-frames:v', '1',
                '-an', '-sn',
                '-vf', `showinfo,scale='min(${options.size},iw)':-2`
            );
            if (options.format === 'jpeg') args.push('-q:v', '2');
            args.push(outPath);
            const singleTimeout = isRemote ? FRAMES_REMOTE_SINGLE_TIMEOUT_MS : FRAMES_SINGLE_TIMEOUT_MS;
            const { stderr } = await runProcess(
                'ffmpeg',
                args,
                singleTimeout,
                'frame extraction timed out',
                { jobDirectory: dir, maxFileBytes: FRAMES_SINGLE_MAX_BYTES, signal }
            );
            const outputInfo = await stat(outPath).catch(() => null);
            if (outputInfo === null || outputInfo.size === 0) {
                throw new HttpError(500, `frame at ${requestedT}s produced no data`);
            }
            if (outputInfo.size > FRAMES_SINGLE_MAX_BYTES) {
                throw new HttpError(500, `frame at ${requestedT}s exceeds the single frame limit`);
            }
            totalBytes += outputInfo.size;
            if (totalBytes > FRAMES_MAX_OUTPUT_BYTES) {
                throw new HttpError(500, 'frames exceed the output limit');
            }
            const data = await readFile(outPath);
            const size = stillImageSizeOf(data);
            frames.push({
                requestedT,
                actualT: actualTimeOf(stderr, requestedT, probe.duration),
                mime,
                width: size === null ? null : size.width,
                height: size === null ? null : size.height,
                data: data.toString('base64'),
            });
        }
        return {
            duration: probe.duration,
            width: probe.width,
            height: probe.height,
            fps: Number.isFinite(probe.fps) ? probe.fps : null,
            rotation: probe.rotation,
            frames,
            notes: [],
        };
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};


const hasMagic = (buffer, magic) =>
    buffer.length >= magic.length && magic.every((value, index) => buffer[index] === value);

const countJsonNodes = (root, maximum) => {
    let count = 0;
    const stack = [root];
    while (stack.length > 0) {
        const value = stack.pop();
        count += 1;
        if (count > maximum) return count;
        if (Array.isArray(value)) {
            for (const item of value) stack.push(item);
        } else if (value && typeof value === 'object') {
            for (const item of Object.values(value)) stack.push(item);
        }
    }
    return count;
};

const parseTgs = async (buffer, maxNodes) => {
    if (!hasMagic(buffer, [0x1f, 0x8b])) throw new HttpError(415, 'invalid TGS gzip magic');
    let jsonBuffer;
    try {
        jsonBuffer = await gunzipAsync(buffer, { maxOutputLength: MAX_TGS_JSON_BYTES });
    } catch {
        throw new HttpError(422, 'invalid or oversized TGS gzip payload');
    }
    let animation;
    try {
        animation = JSON.parse(jsonBuffer.toString('utf8'));
    } catch {
        throw new HttpError(422, 'invalid TGS JSON');
    }
    if (animation === null || typeof animation !== 'object') throw new HttpError(422, 'invalid TGS document');
    if (countJsonNodes(animation, maxNodes) > maxNodes) {
        throw new HttpError(422, `TGS document exceeds ${maxNodes} JSON nodes`);
    }
    const width = Number(animation.w);
    const height = Number(animation.h);
    const frameRate = Number(animation.fr);
    const firstFrame = Number(animation.ip);
    const lastFrame = Number(animation.op);
    const frameCount = lastFrame - firstFrame;
    const duration = frameCount / frameRate;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
        || width > MAX_TGS_DIMENSION || height > MAX_TGS_DIMENSION) {
        throw new HttpError(422, `TGS canvas must be within ${MAX_TGS_DIMENSION}x${MAX_TGS_DIMENSION}`);
    }
    if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > MAX_TGS_FRAME_RATE) {
        throw new HttpError(422, `TGS frame rate must be within 1-${MAX_TGS_FRAME_RATE}`);
    }
    if (!Number.isFinite(frameCount) || frameCount <= 0 || frameCount > MAX_TGS_FRAMES) {
        throw new HttpError(422, `TGS frame count must be within 1-${MAX_TGS_FRAMES}`);
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_TGS_DURATION_SECONDS) {
        throw new HttpError(422, `TGS duration must be within ${MAX_TGS_DURATION_SECONDS} seconds`);
    }
    return animation;
};

const validateTgs = (buffer) => parseTgs(buffer, MAX_TGS_JSON_NODES);

const parseFrameRate = (value) => {
    if (typeof value !== 'string') return Number.NaN;
    const [numeratorText, denominatorText] = value.split('/');
    const numerator = Number(numeratorText);
    const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return Number.NaN;
    return numerator / denominator;
};

const probeMedia = async (filePath, jobDirectory, signal) => {
    const { stdout } = await runProcess('ffprobe', [
        '-v', 'error',
        '-show_streams',
        '-show_format',
        '-of', 'json',
        filePath,
    ], EMOJI_TIMEOUT_MS, 'ffprobe timed out', {
        jobDirectory,
        maxFileBytes: MAX_PROCESS_OUTPUT_BYTES,
        signal,
    });
    try {
        return JSON.parse(stdout);
    } catch {
        throw new HttpError(422, 'invalid ffprobe output');
    }
};

/**
 * @param {object} [options]
 * @param {boolean} [options.allowUnknownDuration] animated images often report
 *   no duration at all; the caller bounds those with `-t` instead.
 */
const probeNormalizeVideo = async (filePath, jobDirectory, signal, options = {}) => {
    const probe = await probeMedia(filePath, jobDirectory, signal);
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const videoStreams = streams.filter((stream) => stream?.codec_type === 'video');
    if (streams.length === 0 || streams.length > MAX_NORMALIZE_STREAMS || videoStreams.length !== 1) {
        throw new HttpError(422, 'video must contain one video stream and a bounded stream count');
    }
    const video = videoStreams[0];
    const width = Number(video.width);
    const height = Number(video.height);
    const duration = Number(video.duration ?? probe.format?.duration);
    const frameRate = parseFrameRate(video.avg_frame_rate || video.r_frame_rate);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
        || width > MAX_NORMALIZE_DIMENSION || height > MAX_NORMALIZE_DIMENSION
        || width * height > MAX_NORMALIZE_PIXELS) {
        throw new HttpError(422, 'video dimensions exceed the normalize limit');
    }
    const durationUsable = Number.isFinite(duration) && duration > 0;
    if (!durationUsable && options.allowUnknownDuration !== true) {
        throw new HttpError(422, 'video duration exceeds the normalize limit');
    }
    if (durationUsable && duration > MAX_NORMALIZE_DURATION_SECONDS) {
        throw new HttpError(422, 'video duration exceeds the normalize limit');
    }
    if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > MAX_NORMALIZE_FRAME_RATE) {
        throw new HttpError(422, 'video frame rate exceeds the normalize limit');
    }
    return { duration: durationUsable ? duration : undefined };
};

const probeWebm = async (filePath, jobDirectory, signal) => {
    const probe = await probeMedia(filePath, jobDirectory, signal);
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const videoStreams = streams.filter((stream) => stream?.codec_type === 'video');
    const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');
    if (streams.length !== 1 || videoStreams.length !== 1 || audioStreams.length !== 0) {
        throw new HttpError(422, 'WEBM must contain exactly one video stream and no audio');
    }
    const video = videoStreams[0];
    const width = Number(video.width);
    const height = Number(video.height);
    const duration = Number(video.duration ?? probe.format?.duration);
    const frameRate = parseFrameRate(video.avg_frame_rate || video.r_frame_rate);
    if (video.codec_name !== 'vp9') throw new HttpError(422, 'WEBM video codec must be VP9');
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
        || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        throw new HttpError(422, 'WEBM dimensions must be within 1024x1024');
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_EMOJI_DURATION_SECONDS) {
        throw new HttpError(422, 'WEBM duration must be within 5 seconds');
    }
    if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > MAX_WEBM_FRAME_RATE) {
        throw new HttpError(422, 'WEBM frame rate must be within 1-60');
    }
    return { duration };
};

const IMAGE_VERIFY_PYTHON = String.raw`
import sys
import warnings
from PIL import Image

Image.MAX_IMAGE_PIXELS = 1048576
warnings.simplefilter('error', Image.DecompressionBombWarning)
path, expected_format = sys.argv[1], sys.argv[2]
with Image.open(path) as image:
    if image.format != expected_format:
        raise ValueError(f'expected {expected_format}, got {image.format}')
    width, height = image.size
    if width <= 0 or height <= 0 or width > 1024 or height > 1024:
        raise ValueError('image dimensions must be within 1024x1024')
    image.verify()
`;

const validateStaticImage = async (filePath, buffer, extension, jobDirectory, signal) => {
    const isPng = extension === '.png';
    const magicValid = isPng
        ? hasMagic(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        : hasMagic(buffer, [0x52, 0x49, 0x46, 0x46])
            && buffer.length >= 12
            && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!magicValid) throw new HttpError(415, `invalid ${isPng ? 'PNG' : 'WEBP'} magic`);
    try {
        await runProcess(
            process.env.PYTHON_BIN || 'python3',
            ['-c', IMAGE_VERIFY_PYTHON, filePath, isPng ? 'PNG' : 'WEBP'],
            EMOJI_TIMEOUT_MS,
            'image validation timed out',
            {
                jobDirectory,
                maxFileBytes: MAX_PROCESS_OUTPUT_BYTES,
                signal,
            }
        );
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(422, `invalid image: ${error instanceof Error ? error.message : 'unknown'}`);
    }
};

const parseBinaryFlag = (searchParams, name) => {
    const value = searchParams.get(name);
    if (value === '0') return false;
    if (value === '1') return true;
    throw new HttpError(400, `${name} must be 0 or 1`);
};

const safeInputExtension = (mime, animated, video) => {
    if (video && mime === 'video/webm') return '.webm';
    if (animated && (mime === 'application/x-tgsticker' || mime === 'application/gzip')) return '.tgs';
    if (!animated && !video && mime === 'image/png') return '.png';
    if (!animated && !video && mime === 'image/webp') return '.webp';
    throw new HttpError(415, `unsupported emoji media combination: ${mime || '(empty)'}`);
};

const createEmojiPreview = async (inputBuffer, options, signal) => {
    const extension = safeInputExtension(options.mime, options.animated, options.video);
    const dir = await mkdtemp(join(tmpdir(), 'emoji-preview-'));
    const inputPath = join(dir, `input${extension}`);
    const webmPath = join(dir, 'converted.webm');
    const outputPath = join(dir, 'preview.png');
    try {
        await writeFile(inputPath, inputBuffer);
        let mediaPath = inputPath;
        let seekSeconds = 0;
        if (extension === '.tgs') {
            await validateTgs(inputBuffer);
            const webm = await convertTgsToWebm(inputBuffer, signal);
            await writeFile(webmPath, webm);
            mediaPath = webmPath;
            seekSeconds = Math.max(0, (await probeVideoDuration(mediaPath, dir, signal)) / 2);
        } else if (extension === '.webm') {
            if (!hasMagic(inputBuffer, [0x1a, 0x45, 0xdf, 0xa3])) {
                throw new HttpError(415, 'invalid WEBM EBML magic');
            }
            seekSeconds = Math.max(0, (await probeWebm(mediaPath, dir, signal)).duration / 2);
        } else {
            await validateStaticImage(inputPath, inputBuffer, extension, dir, signal);
        }

        const foregroundFilter = options.repaint
            ? "format=rgba,lutrgb=r='48':g='210':b='190',format=rgba"
            : 'format=rgba';
        const filter = [
            `color=c=#b8bdc5:s=${EMOJI_PREVIEW_SIZE}x${EMOJI_PREVIEW_SIZE},format=rgba[background]`,
            `[0:v]${foregroundFilter},scale=${EMOJI_PREVIEW_SIZE - 48}:${EMOJI_PREVIEW_SIZE - 48}:force_original_aspect_ratio=decrease[emoji]`,
            '[background][emoji]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgb24[out]',
        ].join(';');
        const args = ['-y'];
        if (seekSeconds > 0) args.push('-ss', seekSeconds.toFixed(3));
        args.push(
            '-threads', '2',
            '-i', mediaPath,
            '-filter_complex', filter,
            '-map', '[out]',
            '-frames:v', '1',
            '-c:v', 'png',
            outputPath
        );
        await runProcess('ffmpeg', args, EMOJI_TIMEOUT_MS, 'emoji preview timed out', {
            jobDirectory: dir,
            maxFileBytes: EMOJI_PREVIEW_MAX_OUTPUT_BYTES,
            signal,
        });
        const outputInfo = await stat(outputPath);
        if (outputInfo.size > EMOJI_PREVIEW_MAX_OUTPUT_BYTES) {
            throw new HttpError(500, `emoji preview output exceeds ${EMOJI_PREVIEW_MAX_OUTPUT_BYTES} bytes`);
        }
        return readFile(outputPath);
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

const decodeAtlasRequest = (body) => {
    let payload;
    try {
        payload = JSON.parse(body.toString('utf8'));
    } catch {
        throw new HttpError(400, 'invalid JSON body');
    }
    if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.items)) {
        throw new HttpError(400, 'items must be an array');
    }
    if (payload.items.length === 0 || payload.items.length > ATLAS_MAX_ITEMS) {
        throw new HttpError(400, `items must contain 1-${ATLAS_MAX_ITEMS} entries`);
    }
    return payload.items.map((item, index) => {
        if (item === null || typeof item !== 'object') {
            throw new HttpError(400, `item ${index + 1} must be an object`);
        }
        const label = item.label;
        const imageBase64 = item.imageBase64;
        if (typeof label !== 'string' || !/^E(?:[1-9]|1[0-6])$/.test(label)) {
            throw new HttpError(400, `item ${index + 1} label must match E1-E16`);
        }
        if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
            throw new HttpError(400, `item ${index + 1} imageBase64 is required`);
        }
        const data = Buffer.from(imageBase64, 'base64');
        const canonicalInput = imageBase64.replace(/=+$/, '');
        if (data.length === 0 || data.toString('base64').replace(/=+$/, '') !== canonicalInput) {
            throw new HttpError(400, `item ${index + 1} imageBase64 is invalid`);
        }
        if (data.length > ATLAS_MAX_IMAGE_BYTES) {
            throw new HttpError(413, `item ${index + 1} image exceeds ${ATLAS_MAX_IMAGE_BYTES} bytes`);
        }
        if (!hasMagic(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
            throw new HttpError(415, `item ${index + 1} is not a PNG`);
        }
        return { label, data };
    });
};

const ATLAS_PYTHON = String.raw`
import json
import sys
import warnings
from PIL import Image, ImageDraw, ImageFont

Image.MAX_IMAGE_PIXELS = 1048576
warnings.simplefilter('error', Image.DecompressionBombWarning)
manifest_path, output_path = sys.argv[1], sys.argv[2]
with open(manifest_path, 'r', encoding='utf-8') as manifest_file:
    items = json.load(manifest_file)
columns = 2
rows = (len(items) + columns - 1) // columns
cell_width = 360
cell_height = 180
atlas = Image.new('RGB', (cell_width * columns, cell_height * rows), '#b8bdc5')
draw = ImageDraw.Draw(atlas)
try:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 26)
except OSError:
    font = ImageFont.load_default()
for index, item in enumerate(items):
    column = index % columns
    row = index // columns
    left = column * cell_width
    top = row * cell_height
    draw.rectangle((left, top, left + cell_width - 1, top + cell_height - 1), fill='#b8bdc5', outline='#626873', width=2)
    for checker_y in range(top + 38, top + cell_height - 8, 24):
        for checker_x in range(left + 70, left + cell_width - 8, 24):
            parity = ((checker_x - left) // 24 + (checker_y - top) // 24) % 2
            fill = '#a2a8b1' if parity == 0 else '#d0d4da'
            draw.rectangle((checker_x, checker_y, checker_x + 23, checker_y + 23), fill=fill)
    with Image.open(item['path']) as candidate:
        width, height = candidate.size
        if candidate.format != 'PNG':
            raise ValueError('atlas item must be PNG')
        if width <= 0 or height <= 0 or width > 1024 or height > 1024:
            raise ValueError('atlas image dimensions must be within 1024x1024')
        candidate.verify()
    with Image.open(item['path']) as candidate:
        image = candidate.convert('RGBA')
        image.load()
    image.thumbnail((258, 130), Image.Resampling.LANCZOS)
    x = left + 70 + (282 - image.width) // 2
    y = top + 42 + (130 - image.height) // 2
    atlas.paste(image, (x, y), image)
    draw.rounded_rectangle((left + 8, top + 10, left + 64, top + 45), radius=4, fill='#20242a')
    draw.text((left + 13, top + 13), item['label'], fill='white', font=font)
atlas.save(output_path, 'PNG', optimize=True)
`;

const createEmojiAtlas = async (items, signal) => {
    const dir = await mkdtemp(join(tmpdir(), 'emoji-atlas-'));
    const manifestPath = join(dir, 'manifest.json');
    const outputPath = join(dir, 'atlas.png');
    try {
        const manifest = [];
        for (const [index, item] of items.entries()) {
            const imagePath = join(dir, `item-${index}.png`);
            await writeFile(imagePath, item.data);
            manifest.push({ label: item.label, path: imagePath });
        }
        await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
        await runProcess(
            process.env.PYTHON_BIN || 'python3',
            ['-c', ATLAS_PYTHON, manifestPath, outputPath],
            EMOJI_TIMEOUT_MS,
            'emoji atlas timed out',
            {
                jobDirectory: dir,
                maxFileBytes: ATLAS_MAX_OUTPUT_BYTES,
                signal,
            }
        );
        const outputInfo = await stat(outputPath);
        if (outputInfo.size > ATLAS_MAX_OUTPUT_BYTES) {
            throw new HttpError(500, `emoji atlas output exceeds ${ATLAS_MAX_OUTPUT_BYTES} bytes`);
        }
        return readFile(outputPath);
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

const sendBuffer = (res, statusCode, headers, data) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(statusCode, headers);
    res.end(data);
};

const sendError = (res, context, error) => {
    const message = error instanceof Error ? error.message : 'unknown';
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    if (statusCode !== 499) console.error(`[tgs-converter] ${context} failed:`, message);
    sendBuffer(res, statusCode, { 'Content-Type': 'text/plain' }, `${context} failed: ${message}`);
};

/** A signed read URL's query is a credential: never let it reach a log line */
const redactUrlSecrets = (text) =>
    text.replace(/(https:\/\/storage\.googleapis\.com\/[^\s"']*)\?[^\s"']*/g, '$1?…');

/**
 * A validation failure that carries values the caller needs to correct itself
 * (source dimensions, the clip duration) answers JSON; everything else keeps
 * the plain-text shape the existing endpoints have.
 */
const sendJsonAwareError = (res, context, error) => {
    if (error instanceof HttpError && error.details !== undefined) {
        const statusCode = error.statusCode;
        if (statusCode !== 499) console.error(`[tgs-converter] ${context} failed:`, error.message);
        sendBuffer(
            res,
            statusCode,
            { 'Content-Type': 'application/json' },
            Buffer.from(JSON.stringify({ error: error.message, ...error.details }))
        );
        return;
    }
    sendError(res, context, error);
};

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    if (req.method === 'POST' && req.url === '/convert') {
        try {
            const webm = await withExpensiveRequest(req, res, async (signal) => {
                const body = await readBody(req, MAX_INPUT_BYTES, signal);
                if (body.length === 0) throw new HttpError(400, 'empty body');
                await validateTgs(body);
                const key = createHash('sha256').update('convert\0').update(body).digest('hex');
                const cached = cacheGet(key);
                if (Buffer.isBuffer(cached)) {
                    console.log(`[tgs-converter] cache hit for ${key.slice(0, 12)}`);
                    return cached;
                }
                const converted = await convertTgsToWebm(body, signal);
                cacheSet(key, converted);
                console.log(`[tgs-converter] converted ${body.length}B tgs -> ${converted.length}B webm (cache miss)`);
                return converted;
            });
            sendBuffer(res, 200, {
                'Content-Type': 'video/webm',
                'Content-Length': webm.length,
            }, webm);
        } catch (error) {
            sendError(res, 'convert', error);
        }
        return;
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/still') {
        try {
            const parsed = new URL(req.url, 'http://localhost');
            const requestedFrame = parsed.searchParams.get('frame');
            const still = await withExpensiveRequest(req, res, async (signal) => {
                const body = await readBody(req, MAX_INPUT_BYTES, signal);
                if (body.length === 0) throw new HttpError(400, 'empty body');
                const animation = await parseTgs(body, MAX_TGS_STILL_JSON_NODES);
                const frame = stillFrameOf(animation, requestedFrame);
                const key = createHash('sha256')
                    .update('still\0')
                    .update(String(frame))
                    .update('\0')
                    .update(body)
                    .digest('hex');
                const cached = cacheGet(key);
                if (Buffer.isBuffer(cached)) {
                    console.log(`[tgs-converter] still cache hit for ${key.slice(0, 12)}`);
                    return cached;
                }
                const rendered = await renderTgsStill(body, frame, signal);
                cacheSet(key, rendered);
                console.log(`[tgs-converter] still ${body.length}B tgs frame=${frame} -> ${rendered.length}B png (cache miss)`);
                return rendered;
            });
            sendBuffer(res, 200, {
                'Content-Type': 'image/png',
                'Content-Length': still.length,
            }, still);
        } catch (error) {
            sendError(res, 'still', error);
        }
        return;
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/normalize-video') {
        try {
            const parsed = new URL(req.url, 'http://localhost');
            const inputMime = parsed.searchParams.get('mime') || 'video/webm';
            const format = parsed.searchParams.get('format');
            if (format !== null && format !== 'mp4') {
                throw new HttpError(400, `unsupported format: ${format}`);
            }
            // A GIF is only ever read as a still image; re-encode it so the
            // caller gets something a model can watch
            const forceMp4 = format === 'mp4' || inputMime === 'image/gif';
            const normalized = await withExpensiveRequest(req, res, async (signal) => {
                if (!NORMALIZE_VIDEO_MIMES.has(inputMime)) {
                    throw new HttpError(415, `unsupported video MIME: ${inputMime}`);
                }
                const body = await readBody(req, NORMALIZE_MAX_INPUT_BYTES, signal);
                if (body.length === 0) throw new HttpError(400, 'empty body');
                const key = createHash('sha256').update('normalize\0').update(inputMime).update('\0').update(format ?? '').update('\0').update(body).digest('hex');
                const cached = cacheGet(key);
                if (cached !== undefined && !Buffer.isBuffer(cached)) {
                    console.log(`[tgs-converter] normalize cache hit for ${key.slice(0, 12)}`);
                    return cached;
                }
                const result = await normalizeShortVideo(body, inputMime, signal, { forceMp4 });
                if (result.normalized) cacheSet(key, result);
                console.log(`[tgs-converter] ${result.normalized ? 'normalized' : 'passed'} ${body.length}B ${inputMime} -> ${result.data.length}B ${result.mimeType} (cache miss)`);
                return result;
            });
            sendBuffer(res, 200, {
                'Content-Type': normalized.mimeType,
                'Content-Length': normalized.data.length,
                'X-Normalized': normalized.normalized ? '1' : '0',
            }, normalized.data);
        } catch (error) {
            sendError(res, 'normalize', error);
        }
        return;
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/frame') {
        try {
            const parsed = new URL(req.url, 'http://localhost');
            const inputMime = parsed.searchParams.get('mime') || '';
            const requestedFormat = parsed.searchParams.get('format');
            if (requestedFormat !== null && requestedFormat !== 'jpeg' && requestedFormat !== 'png') {
                throw new HttpError(400, `unsupported format: ${requestedFormat}`);
            }
            if (!FRAME_VIDEO_MIMES.has(inputMime)) {
                throw new HttpError(415, `unsupported video MIME: ${inputMime}`);
            }
            const format = requestedFormat ?? (inputMime === 'video/webm' ? 'png' : 'jpeg');
            const frame = await withExpensiveRequest(req, res, async (signal) => {
                const body = await readBody(req, FRAME_MAX_INPUT_BYTES, signal);
                if (body.length === 0) throw new HttpError(400, 'empty body');
                const key = createHash('sha256')
                    .update('frame\0')
                    .update(inputMime)
                    .update('\0')
                    .update(format)
                    .update('\0')
                    .update(body)
                    .digest('hex');
                const cached = cacheGet(key);
                if (Buffer.isBuffer(cached)) {
                    console.log(`[tgs-converter] frame cache hit for ${key.slice(0, 12)}`);
                    return cached;
                }
                const extracted = await extractFirstFrame(body, inputMime, format, signal);
                cacheSet(key, extracted);
                console.log(`[tgs-converter] frame ${body.length}B ${inputMime} -> ${extracted.length}B ${format} (cache miss)`);
                return extracted;
            });
            sendBuffer(res, 200, {
                'Content-Type': format === 'png' ? 'image/png' : 'image/jpeg',
                'Content-Length': frame.length,
            }, frame);
        } catch (error) {
            sendError(res, 'frame', error);
        }
        return;
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/crop') {
        try {
            const parsed = new URL(req.url, 'http://localhost');
            const options = parseCropQuery(parsed.searchParams);
            const body = await readBody(req, CROP_MAX_INPUT_BYTES);
            if (body.length === 0) throw new HttpError(400, 'empty body');
            const key = createHash('sha256')
                .update('crop\0')
                .update(JSON.stringify(options))
                .update('\0')
                .update(body)
                .digest('hex');
            let cropped = cacheGet(key);
            if (cropped !== undefined && Buffer.isBuffer(cropped) === false) {
                console.log(`[tgs-converter] crop cache hit for ${key.slice(0, 12)}`);
            } else {
                cropped = await cropStillImage(body, options);
                cacheSet(key, cropped);
                console.log(`[tgs-converter] crop ${body.length}B box=${cropped.meta.x1},${cropped.meta.y1},${cropped.meta.x2},${cropped.meta.y2} -> ${cropped.data.length}B ${cropped.mime} (cache miss)`);
            }
            sendBuffer(res, 200, {
                'Content-Type': cropped.mime,
                'Content-Length': cropped.data.length,
                'X-Source-Width': String(cropped.meta.sourceWidth),
                'X-Source-Height': String(cropped.meta.sourceHeight),
                'X-Crop-X1': String(cropped.meta.x1),
                'X-Crop-Y1': String(cropped.meta.y1),
                'X-Crop-X2': String(cropped.meta.x2),
                'X-Crop-Y2': String(cropped.meta.y2),
                'X-Output-Width': String(cropped.meta.outputWidth),
                'X-Output-Height': String(cropped.meta.outputHeight),
                'X-Crop-Flags': cropped.meta.flags.join(','),
            }, cropped.data);
        } catch (error) {
            sendJsonAwareError(res, 'crop', error);
        }
        return;
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/frames') {
        let remoteUrl = null;
        try {
            const parsed = new URL(req.url, 'http://localhost');
            remoteUrl = resolveRemoteVideoUrl(parsed.searchParams);
            const inputMime = parsed.searchParams.get('mime') ?? '';
            const options = parseFramesQuery(parsed.searchParams, inputMime);
            const declaredSourceBytes = Number(parsed.searchParams.get('sourceBytes'));
            if (remoteUrl !== null && Number.isFinite(declaredSourceBytes)
                && declaredSourceBytes > FRAMES_MAX_REMOTE_INPUT_BYTES) {
                throw new HttpError(413, 'remote input exceeds the size limit');
            }
            const result = await withExpensiveRequest(req, res, async (signal) => {
                if (remoteUrl !== null) {
                    console.log(`[tgs-converter] frames remote ${inputMime} mode=${options.mode} (no cache)`);
                    return extractFrames({ kind: 'url', url: remoteUrl }, options, signal);
                }
                const body = await readBody(req, FRAMES_MAX_INPUT_BYTES, signal);
                if (body.length === 0) throw new HttpError(400, 'empty body');
                const key = createHash('sha256')
                    .update('frames\0')
                    .update(inputMime)
                    .update('\0')
                    .update(JSON.stringify(options))
                    .update('\0')
                    .update(body)
                    .digest('hex');
                const cached = cacheGet(key);
                if (Buffer.isBuffer(cached)) {
                    console.log(`[tgs-converter] frames cache hit for ${key.slice(0, 12)}`);
                    try {
                        return JSON.parse(cached.toString('utf8'));
                    } catch {
                        // A corrupted cache entry is not worth failing over
                    }
                }
                const extracted = await extractFrames({ kind: 'bytes', data: body }, options, signal);
                cacheSet(key, Buffer.from(JSON.stringify(extracted)));
                console.log(`[tgs-converter] frames ${body.length}B ${inputMime} mode=${options.mode} -> ${extracted.frames.length} frame(s) (cache miss)`);
                return extracted;
            });
            sendBuffer(res, 200, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(JSON.stringify(result)),
            }, Buffer.from(JSON.stringify(result)));
        } catch (error) {
            if (remoteUrl !== null && error instanceof Error) {
                // ffprobe/ffmpeg quote the URL in their errors; its query is a signature
                const message = redactUrlSecrets(error.message);
                const statusCode = error instanceof HttpError ? error.statusCode : 500;
                const details = error instanceof HttpError ? error.details : undefined;
                sendJsonAwareError(res, 'frames', new HttpError(statusCode, message, details));
                return;
            }
            sendJsonAwareError(res, 'frames', error);
        }
        return;
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/emoji-preview') {
        try {
            const parsed = new URL(req.url, 'http://localhost');
            const options = {
                mime: parsed.searchParams.get('mime') || '',
                animated: parseBinaryFlag(parsed.searchParams, 'animated'),
                video: parseBinaryFlag(parsed.searchParams, 'video'),
                repaint: parseBinaryFlag(parsed.searchParams, 'repaint'),
            };
            const png = await withExpensiveRequest(req, res, async (signal) => {
                const body = await readBody(req, EMOJI_MAX_INPUT_BYTES, signal);
                if (body.length === 0) throw new HttpError(400, 'empty body');
                safeInputExtension(options.mime, options.animated, options.video);
                const key = createHash('sha256')
                    .update('emoji-preview\0')
                    .update(JSON.stringify(options))
                    .update('\0')
                    .update(body)
                    .digest('hex');
                const cached = cacheGet(key);
                if (Buffer.isBuffer(cached)) {
                    console.log(`[tgs-converter] emoji preview cache hit for ${key.slice(0, 12)}`);
                    return cached;
                }
                const preview = await createEmojiPreview(body, options, signal);
                cacheSet(key, preview);
                console.log(`[tgs-converter] emoji preview ${body.length}B -> ${preview.length}B (cache miss)`);
                return preview;
            });
            sendBuffer(res, 200, {
                'Content-Type': 'image/png',
                'Content-Length': png.length,
            }, png);
        } catch (error) {
            sendError(res, 'emoji preview', error);
        }
        return;
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/emoji-atlas') {
        try {
            const png = await withExpensiveRequest(req, res, async (signal) => {
                const body = await readBody(req, ATLAS_MAX_BODY_BYTES, signal);
                if (body.length === 0) throw new HttpError(400, 'empty body');
                const key = createHash('sha256').update('emoji-atlas\0').update(body).digest('hex');
                const cached = cacheGet(key);
                if (Buffer.isBuffer(cached)) {
                    console.log(`[tgs-converter] emoji atlas cache hit for ${key.slice(0, 12)}`);
                    return cached;
                }
                const items = decodeAtlasRequest(body);
                const atlas = await createEmojiAtlas(items, signal);
                cacheSet(key, atlas);
                console.log(`[tgs-converter] emoji atlas ${items.length} items -> ${atlas.length}B (cache miss)`);
                return atlas;
            });
            sendBuffer(res, 200, {
                'Content-Type': 'image/png',
                'Content-Length': png.length,
            }, png);
        } catch (error) {
            sendError(res, 'emoji atlas', error);
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
});

server.headersTimeout = 10000;
server.requestTimeout = 70000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 32;
server.maxRequestsPerSocket = 100;

server.listen(PORT, () => {
    console.log(`[tgs-converter] listening on :${PORT}`);
});
