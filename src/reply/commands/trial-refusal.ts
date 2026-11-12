/**
 * The one refusal for a paid or GPU-heavy feature a trial user tried to run.
 *
 * It never says the model can file an application: the user applies themselves
 * from /apply or the Mini App (design D4). Callers pass the tier they already
 * resolved, so the refusal and the actual block use the same decision.
 */
import type { Context } from 'grammy';
import { TRIAL_DENIED_COMMANDS, TRIAL_MODEL } from '../../config/trial-access.js';
import { isTrialTier, type AccessTier } from '../../services/access-tier.js';
import { sendBotNotice } from '../../services/bot-notice-service.js';

export const TRIAL_COMMAND_REFUSAL_TEXT =
    '体验用户不能使用这个功能。可用的生图命令只有 /picbanana；完整功能（其它模型、gpt/Grok 生图、/pic、/vid 等）需要申请准入。\n' +
    '申请方式：在对话里发送 /apply，或打开 Mini App 的「准入」页填写。';

export const TRIAL_MODEL_REFUSAL_TEXT =
    `体验用户固定使用 ${TRIAL_MODEL}，不能切换模型。\n` +
    '需要完整功能的话，发送 /apply 或打开 Mini App 的「准入」页申请准入。';

/** Short form for a callback toast (a notice would be a second message) */
export const TRIAL_CALLBACK_REFUSAL_TEXT = '体验用户不能使用这个功能；发送 /apply 申请准入';

/** Whether this command name is one a trial user may not run */
export const isTrialDeniedCommand = (command: string): boolean =>
    TRIAL_DENIED_COMMANDS.has(command);

/**
 * Send the refusal when a trial user tried a denied generation command.
 * Resolves true when it refused (the caller then stops).
 */
export const refuseTrialGeneration = async (
    ctx: Context,
    tier: AccessTier,
    command: string
): Promise<boolean> => {
    if (!isTrialTier(tier) || !isTrialDeniedCommand(command)) return false;
    await sendBotNotice(ctx, TRIAL_COMMAND_REFUSAL_TEXT);
    return true;
};
