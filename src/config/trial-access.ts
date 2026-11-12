/**
 * The trial tier's fixed model, application limits and the global kill switch.
 *
 * A trial user's replies use TRIAL_MODEL whatever the chat's model setting says,
 * and the expensive commands/tools are refused. ACCESS_TIERS=0 turns the whole
 * feature off (everyone is treated as full, i.e. today's behavior); unset or
 * empty keeps it on, which is the production default.
 */

/** What a trial user's replies use, whatever the chat's model setting says */
export const TRIAL_MODEL = 'gemini-3.8-flash';

/**
 * Commands a trial user may not run. `/picbanana` stays allowed (banana is the
 * one image model a trial user gets); these are the paid or GPU-heavy ones.
 */
export const TRIAL_DENIED_COMMANDS: ReadonlySet<string> = new Set([
    'pic',
    'picunsafe',
    'vid',
    'vidunsafe',
    'picgpt',
    'picgrok',
]);

/** Application fields: code points after trimming; both are required */
export const ACCESS_IDENTITY_MAX_CODE_POINTS = 500;
export const ACCESS_PURPOSE_MAX_CODE_POINTS = 1000;

/** The owner's optional message on a decision */
export const ACCESS_REVIEW_COMMENT_MAX_CODE_POINTS = 500;

/** Feature switch: ACCESS_TIERS=0 disables tiering (rollback without a code revert) */
export const accessTiersEnabled = (): boolean => process.env.ACCESS_TIERS !== '0';
