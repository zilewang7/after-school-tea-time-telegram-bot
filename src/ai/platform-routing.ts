/**
 * Which platform serves a model id, decided by prefix. Unknown ids go to
 * OpenAI (it fronts the relay, which serves everything else).
 *
 * Lives apart from platform-factory, which imports and instantiates every
 * platform: modules the platforms themselves import (model-kinds) can ask for
 * a platform type here without closing an import cycle.
 */
import { match } from 'ts-pattern';
import type { PlatformType } from './types.js';

export const platformTypeOf = (model: string): PlatformType =>
    match(model.toLowerCase())
        .when((id) => id.startsWith('gemini'), (): PlatformType => 'gemini')
        .when((id) => id.startsWith('deepseek'), (): PlatformType => 'deepseek')
        .when((id) => id.startsWith('grok-'), (): PlatformType => 'grok')
        .when((id) => id.startsWith('mimo'), (): PlatformType => 'mimo')
        .when((id) => id.startsWith('claude'), (): PlatformType => 'anthropic')
        .otherwise((): PlatformType => 'openai');
