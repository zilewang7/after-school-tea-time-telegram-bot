/**
 * Whether a reply's request asks Vertex for Priority PayGo (design
 * 2026-1112-1123 §8): where the chat's effective switch is on, and only for an
 * owner or full turn. A trial turn runs TRIAL_MODEL, the cheap path: a model
 * with no priority price, whose behaviour with the header was never measured.
 * The chat handler, the retry and the continue share this rule.
 */
import type { PlatformConfig } from '../ai/types.js';
import { isTrialTier, type AccessTier } from '../services/access-tier.js';

export const priorityRequestOf = (access: AccessTier, chatPriority: boolean): Pick<PlatformConfig, 'serviceTier'> =>
    chatPriority && !isTrialTier(access) ? { serviceTier: 'priority' } : {};
