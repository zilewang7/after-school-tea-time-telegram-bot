/**
 * Which platform serves a model id, decided by prefix. Unknown ids go to
 * OpenAI (it fronts the relay, which serves everything else).
 *
 * Lives in `src/config` (layer 0) so config, services and ai share one routing
 * rule without upward imports or duplicates.
 */
import { match } from 'ts-pattern';

export type PlatformType = 'openai' | 'gemini' | 'deepseek' | 'grok' | 'mimo' | 'anthropic';

export const platformTypeOf = (model: string): PlatformType =>
    match(model.toLowerCase())
        .when((id) => id.startsWith('gemini'), (): PlatformType => 'gemini')
        .when((id) => id.startsWith('deepseek'), (): PlatformType => 'deepseek')
        .when((id) => id.startsWith('grok-'), (): PlatformType => 'grok')
        .when((id) => id.startsWith('mimo'), (): PlatformType => 'mimo')
        .when((id) => id.startsWith('claude'), (): PlatformType => 'anthropic')
        .otherwise((): PlatformType => 'openai');
