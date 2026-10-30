/**
 * Base platform class with retry logic
 */
import { match } from 'ts-pattern';
import { isRetryableError, getRetryWaitTime } from '../../shared/errors.js';
import type {
    IAIPlatform,
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
    SendOptions,
} from '../types.js';

/** Human-readable byte size, e.g. 104.8MB. */
const formatBytes = (n: number): string => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
};

/** Aborts surface as DOMException AbortError, undici errors or the SDK's own text */
const isAbortError = (error: unknown): boolean =>
    error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));

const toError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

export abstract class BasePlatform implements IAIPlatform {
    abstract readonly type: PlatformType;

    abstract sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>>;

    abstract supportsModel(model: string): boolean;

    abstract getModelCapabilities(model: string): ModelCapabilities;

    /**
     * Send message with retry logic.
     *
     * `operation` receives the signal of THIS attempt. An attempt that runs out
     * of time is aborted before the retry is sent: a request left running next
     * to its own retry bills twice and presses twice on the upstream quota,
     * which is how a slow start turns into 429s and even slower starts.
     */
    protected async sendWithRetry<T>(
        operation: (signal: AbortSignal) => Promise<T>,
        options: SendOptions = { timeout: 85000, maxRetries: 3 }
    ): Promise<T> {
        const { timeout, maxRetries, onRetry, signal } = options;
        const timeoutIncrement = 30000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            // Check if aborted before each attempt
            if (signal?.aborted) {
                throw new Error('Aborted');
            }

            const currentTimeout = timeout + (attempt - 1) * timeoutIncrement;
            const attemptController = new AbortController();
            const abortOnStop = () => attemptController.abort();
            signal?.addEventListener('abort', abortOnStop, { once: true });
            let timedOut = false;
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

            let err: Error;
            try {
                // The attempt is awaited through a race, not just awaited: a
                // platform that ignores its signal must still time out.
                const operationPromise = operation(attemptController.signal);
                // A late rejection of an abandoned attempt must not escape as an
                // unhandled rejection once the race has already moved on.
                operationPromise.catch(() => undefined);
                const timeoutPromise = new Promise<never>((_resolve, reject) => {
                    timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        reject(new Error('Timeout'));
                        attemptController.abort();
                    }, currentTimeout);
                });

                const result = await Promise.race([operationPromise, timeoutPromise]);
                if (timeoutHandle) clearTimeout(timeoutHandle);
                // The stop listener stays for the lifetime of what the attempt
                // opened (a stream outlives this call) so stop still aborts it.
                return result;
            } catch (error) {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                signal?.removeEventListener('abort', abortOnStop);
                if (signal?.aborted || (!timedOut && isAbortError(error))) {
                    throw new Error('Aborted');
                }
                err = toError(error);
            }

            const shouldRetry = isRetryableError(err) && attempt < maxRetries;
            if (shouldRetry) {
                const waitTime = getRetryWaitTime(err);
                console.log(
                    `[${this.type}] Retry attempt ${attempt}/${maxRetries}, ` +
                    `waiting ${waitTime}ms, error: ${err.message.substring(0, 100)}`
                );

                onRetry?.(attempt, err);
                await this.sleep(waitTime, signal);
            } else {
                throw err;
            }
        }

        throw new Error('Maximum retries exceeded');
    }

    /**
     * Sleep for specified milliseconds (interruptible by abort signal)
     */
    protected sleep(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new Error('Aborted'));
                return;
            }

            const timeoutId = setTimeout(resolve, ms);

            const abortHandler = () => {
                clearTimeout(timeoutId);
                reject(new Error('Aborted'));
            };
            signal?.addEventListener('abort', abortHandler, { once: true });
        });
    }

    /**
     * Log message contents for debugging (truncate image URLs)
     */
    protected logMessageContents(messages: UnifiedMessage[]): void {
        messages.forEach((message) => {
            const logContent = message.content.map((part) =>
                match(part)
                    .with({ type: 'image' }, (p) => ({
                        type: 'image',
                        size: formatBytes(p.sizeBytes ?? (p.imageData?.length ?? 0)),
                    }))
                    .with({ type: 'text' }, (p) => ({
                        type: 'text',
                        text: p.text?.substring(0, 100) + (p.text && p.text.length > 100 ? '...' : ''),
                    }))
                    .with({ type: 'media' }, (p) => ({
                        type: 'media',
                        mime: p.mimeType,
                        size: formatBytes(p.sizeBytes ?? Math.floor((p.mediaData?.length ?? 0) * 3 / 4)),
                        ...(p.fileUri ? { fileUri: p.fileUri } : {}),
                    }))
                    .exhaustive()
            );

            console.log(`[${this.type}] ${message.role}:`, { content: logContent });
        });
    }

    /**
     * Default model capabilities (can be overridden)
     */
    protected getDefaultCapabilities(): ModelCapabilities {
        return {
            supportsImageInput: true,
            supportsImageOutput: false,
            supportsSystemPrompt: true,
            requiresMessageMerge: false,
            supportsThinking: false,
            supportsGrounding: false,
            supportsMediaInput: false,
        };
    }
}
