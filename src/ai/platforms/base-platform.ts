/**
 * Base platform class with retry logic
 */
import { match } from 'ts-pattern';
import { to, isErr } from '../../shared/result';
import { isRetryableError, getRetryWaitTime } from '../../shared/errors';
import type {
    IAIPlatform,
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
    SendOptions,
} from '../types';

export abstract class BasePlatform implements IAIPlatform {
    abstract readonly type: PlatformType;

    abstract sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>>;

    abstract supportsModel(model: string): boolean;

    abstract getModelCapabilities(model: string): ModelCapabilities;

    /**
     * Send message with retry logic
     */
    protected async sendWithRetry<T>(
        operation: () => Promise<T>,
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

            const opResult = await to(
                this.withTimeout(operation(), currentTimeout, signal)
            );

            if (!isErr(opResult)) {
                return opResult[1];
            }

            const err = opResult[0];

            // Don't retry if aborted
            if (signal?.aborted || err.message === 'Aborted') {
                throw new Error('Aborted');
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
     * Wrap promise with timeout and abort signal
     */
    protected withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
        return new Promise((resolve, reject) => {
            // Check if already aborted
            if (signal?.aborted) {
                reject(new Error('Aborted'));
                return;
            }

            const timeoutId = setTimeout(() => {
                reject(new Error('Timeout'));
            }, ms);

            // Listen for abort
            const abortHandler = () => {
                clearTimeout(timeoutId);
                reject(new Error('Aborted'));
            };
            signal?.addEventListener('abort', abortHandler, { once: true });

            promise
                .then((result) => {
                    clearTimeout(timeoutId);
                    signal?.removeEventListener('abort', abortHandler);
                    resolve(result);
                })
                .catch((error) => {
                    clearTimeout(timeoutId);
                    signal?.removeEventListener('abort', abortHandler);
                    reject(error);
                });
        });
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
                        dataLength: p.imageData?.length ?? 0,
                    }))
                    .with({ type: 'text' }, (p) => ({
                        type: 'text',
                        text: p.text?.substring(0, 100) + (p.text && p.text.length > 100 ? '...' : ''),
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
        };
    }
}
