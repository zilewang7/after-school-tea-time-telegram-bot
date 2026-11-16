/**
 * The refusals of a trial user: the one for a paid or GPU-heavy feature they
 * tried to run, and the one for the spend cap (design 2026-1116-1500 §D7).
 *
 * They never say the model can file an application: the user applies themselves
 * from /apply or the Mini App (design D4). Callers pass the tier/spend they
 * already resolved, so the refusal and the actual block use the same decision.
 */
import type { Context } from 'grammy';
import { TRIAL_DENIED_COMMANDS, TRIAL_MODEL } from '../../config/trial-access.js';
import { isTrialTier, type AccessTier } from '../../services/access-tier.js';
import { sendBotNotice } from '../../services/bot-notice-service.js';
import type { TrialSpend } from '../../services/trial-quota.js';

/** Amounts in the user-facing copies always carry two decimals: $3.00, $0.04 */
const usdText = (value: number): string => `$${value.toFixed(2)}`;

export const TRIAL_COMMAND_REFUSAL_TEXT =
    '体验用户不能使用这个功能。可用的生图命令只有 /picbanana；完整功能（其它模型、gpt/Grok 生图、/pic、/vid 等）需要申请准入。\n' +
    '申请方式：在对话里发送 /apply，或打开 Mini App 的「准入」页填写。';

export const TRIAL_MODEL_REFUSAL_TEXT =
    `体验用户固定使用 ${TRIAL_MODEL}，不能切换模型。\n` +
    '需要完整功能的话，发送 /apply 或打开 Mini App 的「准入」页申请准入。';

/** Short form for a callback toast (a notice would be a second message) */
export const TRIAL_CALLBACK_REFUSAL_TEXT = '体验用户不能使用这个功能；发送 /apply 申请准入';

/**
 * The spend cap is used up: no generation of this trial user may start. The
 * amount is the one the same quota check returned, so the copy and the block
 * cannot disagree.
 */
export const trialQuotaRefusalText = (spend: TrialSpend): string =>
    `体验额度已用完（已用约 ${usdText(spend.usedUsd)} / ${usdText(spend.limitUsd)}）。\n` +
    '体验用户的累计花费有上限，额度用完后的回复、重试、继续和生图都会被拒绝。\n' +
    '申请方式：在对话里发送 /apply，或打开 Mini App 的「准入」页填写；机主批准后不再受体验额度限制。';

/** Short form for a callback toast (the full refusal would be a second message) */
export const TRIAL_QUOTA_CALLBACK_TEXT = '体验额度已用完；发送 /apply 或打开 Mini App 准入页申请';

/** The toast of a refused "继续": the checkpoint and its buttons are kept for later */
export const TRIAL_QUOTA_CONTINUE_NOTICE = '体验额度已用完，请发送 /apply 申请准入';

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

/**
 * Send the spend-cap refusal when a quota check found the cap used up.
 * Resolves true when it refused (the caller then stops). A null spend (not a
 * trial user, or the feature is off) never refuses.
 */
export const refuseTrialQuota = async (
    ctx: Context,
    spend: TrialSpend | null
): Promise<boolean> => {
    if (spend === null || !spend.exceeded) return false;
    await sendBotNotice(ctx, trialQuotaRefusalText(spend));
    return true;
};
