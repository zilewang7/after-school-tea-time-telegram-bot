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
        const { timeout, maxRetries, onRetry } = options;
        const timeoutIncrement = 30000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const currentTimeout = timeout + (attempt - 1) * timeoutIncrement;

            const opResult = await to(
                this.withTimeout(operation(), currentTimeout)
            );

            if (!isErr(opResult)) {
                return opResult[1];
            }

            const err = opResult[0];
            const shouldRetry = isRetryableError(err) && attempt < maxRetries;

            if (shouldRetry) {
                const waitTime = getRetryWaitTime(err);
                console.log(
                    `[${this.type}] Retry attempt ${attempt}/${maxRetries}, ` +
                    `waiting ${waitTime}ms, error: ${err.message.substring(0, 100)}`
                );

                onRetry?.(attempt, err);
                await this.sleep(waitTime);
            } else {
                throw err;
            }
        }

        throw new Error('Maximum retries exceeded');
    }

    /**
     * Wrap promise with timeout
     */
    protected withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Timeout'));
            }, ms);

            promise
                .then((result) => {
                    clearTimeout(timeoutId);
                    resolve(result);
                })
                .catch((error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                });
        });
    }

    /**
     * Sleep for specified milliseconds
     */
    protected sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
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
