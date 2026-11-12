/**
 * Map the resolved trigger access into the runtime block's note.
 *
 * Only a trial turn carries the note (the static head explains what the tier
 * may use); a full turn adds nothing to the volatile tail, so its prompt stays
 * exactly as before the feature.
 */
import type { TriggerAccessNote } from '../ai/system-prompt/runtime-context.js';
import type { TriggerAccessInfo } from '../services/access-tier.js';

export const triggerAccessNoteOf = (trigger: TriggerAccessInfo): TriggerAccessNote | null =>
    trigger.tier === 'trial'
        ? {
              userId: trigger.userId,
              name: trigger.name,
              applicationStatus: trigger.application?.status ?? null,
              applicationComment: trigger.application?.comment ?? null,
          }
        : null;
