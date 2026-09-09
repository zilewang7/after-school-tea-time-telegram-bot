/**
 * tgs-converter: HTTP media helpers around rlottie, ffmpeg, and Pillow.
 *
 * Endpoints:
 *   POST /convert          body = raw .tgs bytes          -> video/webm
 *   POST /normalize-video  body = raw video bytes         -> original or video/mp4
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
const MAX_TGS_JSON_NODES = 20000;
const MAX_EMOJI_DURATION_SECONDS = 5;
const MAX_WEBM_FRAME_RATE = 60;
const MAX_NORMALIZE_DIMENSION = 4096;
const MAX_NORMALIZE_PIXELS = 16 * 1024 * 1024;
const MAX_NORMALIZE_DURATION_SECONDS = 6 * 60 * 60;
const MAX_NORMALIZE_FRAME_RATE = 240;
const MAX_NORMALIZE_STREAMS = 8;
const NORMALIZE_VIDEO_MIMES = new Set([
    'video/mp4', 'video/mpeg', 'video/mov', 'video/quicktime', 'video/avi',
    'video/x-msvideo', 'video/x-flv', 'video/mpg', 'video/mpegps',
    'video/webm', 'video/wmv', 'video/x-ms-wmv', 'video/3gpp',
]);
const MAX_EXPENSIVE_PROCESSES = positiveIntegerEnv('MAX_EXPENSIVE_PROCESSES', 3, 8);
const MAX_EXPENSIVE_QUEUE = nonNegativeIntegerEnv('MAX_EXPENSIVE_QUEUE', 32, 128);
const gunzipAsync = promisify(gunzip);

class HttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
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

const normalizeShortVideo = async (videoBuffer, inputMime, signal) => {
    if (!NORMALIZE_VIDEO_MIMES.has(inputMime)) {
        throw new HttpError(415, `unsupported video MIME: ${inputMime}`);
    }
    const dir = await mkdtemp(join(tmpdir(), 'normalize-'));
    const inPath = join(dir, 'input.bin');
    const outPath = join(dir, 'output.mp4');
    try {
        await writeFile(inPath, videoBuffer);
        const videoInfo = await probeNormalizeVideo(inPath, dir, signal);
        if (videoInfo.duration >= MIN_VIDEO_SECONDS) {
            return { data: videoBuffer, mimeType: inputMime, normalized: false };
        }
        await runProcess('ffmpeg', [
            '-y',
            '-threads', '2',
            '-stream_loop', '-1',
            '-i', inPath,
            '-t', String(MIN_VIDEO_SECONDS),
            '-c:v', 'libx264',
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

const validateTgs = async (buffer) => {
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
    if (countJsonNodes(animation, MAX_TGS_JSON_NODES) > MAX_TGS_JSON_NODES) {
        throw new HttpError(422, `TGS document exceeds ${MAX_TGS_JSON_NODES} JSON nodes`);
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
};

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

const probeNormalizeVideo = async (filePath, jobDirectory, signal) => {
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
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_NORMALIZE_DURATION_SECONDS) {
        throw new HttpError(422, 'video duration exceeds the normalize limit');
    }
    if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > MAX_NORMALIZE_FRAME_RATE) {
        throw new HttpError(422, 'video frame rate exceeds the normalize limit');
    }
    return { duration };
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

    if (req.method === 'POST' && req.url.split('?')[0] === '/normalize-video') {
        try {
            const parsed = new URL(req.url, 'http://localhost');
            const inputMime = parsed.searchParams.get('mime') || 'video/webm';
            const normalized = await withExpensiveRequest(req, res, async (signal) => {
                if (!NORMALIZE_VIDEO_MIMES.has(inputMime)) {
                    throw new HttpError(415, `unsupported video MIME: ${inputMime}`);
                }
                const body = await readBody(req, NORMALIZE_MAX_INPUT_BYTES, signal);
                if (body.length === 0) throw new HttpError(400, 'empty body');
                const key = createHash('sha256').update('normalize\0').update(inputMime).update('\0').update(body).digest('hex');
                const cached = cacheGet(key);
                if (cached !== undefined && !Buffer.isBuffer(cached)) {
                    console.log(`[tgs-converter] normalize cache hit for ${key.slice(0, 12)}`);
                    return cached;
                }
                const result = await normalizeShortVideo(body, inputMime, signal);
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
