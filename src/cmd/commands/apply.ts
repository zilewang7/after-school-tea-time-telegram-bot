/**
 * `/apply` — a trial user's access application (design D4).
 *
 * The model never files an application; the user does, here or in the Mini App.
 * `/apply` without an argument shows the current state and how to apply;
 * `/apply 你是谁 | 你要做什么` files one. Both paths share the service's field
 * rules and one-pending rule, so the command and the panel form cannot drift.
 */
import type { Bot, Context } from 'grammy';
import { match } from 'ts-pattern';
import { isPanelRunning } from '../../panel/panel-state.js';
import { resolveAccessTier } from '../../services/access-tier.js';
import { notifyOwnerOfApplication } from '../../services/access-application-notify.js';
import { sendBotNotice } from '../../services/bot-notice-service.js';
import { latestApplicationOf } from '../../services/user-access-cache.js';
import {
    AccessApplicationError,
    createAccessApplication,
} from '../../services/user-access-service.js';
import { miniAppKeyboardForChat } from './mini-app-link.js';

const USAGE = [
    '用法：/apply 你是谁 | 你要做什么',
    '例如：/apply 我是黑猫的朋友 | 想用 gpt 生图和更强的模型',
].join('\n');

const APPLY_HEADER =
    '你是体验用户。完整功能（切换模型、gpt/Grok 生图、/pic、/vid、MCP 工具等）需要机主批准后才能使用。\n' +
    '如果你在机主指定的群聊里，完整功能会自动恢复，无需申请。\n' +
    '申请时请说明两件事：你是谁（身份、与机主的关系）、你要做什么（用途）。';

const formatTime = (date: Date): string => {
    const timeZone = process.env.TZ || 'Asia/Shanghai';
    return date.toLocaleString('zh-CN', { hour12: false, timeZone });
};

/** The current application state and how to proceed */
const statusTextOf = (userId: number): string => {
    const application = latestApplicationOf(userId);
    if (application === null) return `${APPLY_HEADER}\n${USAGE}`;
    return match(application.status)
        .with(
            'pending',
            () => `你有一条待审核的准入申请（提交于 ${formatTime(application.createdAt)}），请等待机主审核。`
        )
        .with(
            'rejected',
            () =>
                `你上次的准入申请未通过。${application.comment === null ? '' : `\n机主留言：${application.comment}`}\n` +
                `补充信息后可以重新申请。\n${USAGE}`
        )
        .with(
            'approved',
            () =>
                '你当前的等级是体验用户（准入可能已被取消）。可以重新提交申请。\n' + USAGE
        )
        .exhaustive();
};

/** Split on the first `|` / `｜`; null when either side is blank */
const splitApplicationText = (raw: string): { identity: string; purpose: string } | null => {
    const separatorIndex = raw.search(/[|｜]/);
    if (separatorIndex < 0) return null;
    const identity = raw.slice(0, separatorIndex).trim();
    const purpose = raw.slice(separatorIndex + 1).trim();
    if (identity === '' || purpose === '') return null;
    return { identity, purpose };
};

const replyWithStatus = async (ctx: Context): Promise<void> => {
    if (!ctx.chat || !ctx.from) return;
    const keyboard = isPanelRunning() ? miniAppKeyboardForChat(ctx.chat, '打开准入申请') : null;
    // Only promise the Mini App entry when it is actually reachable from here
    const miniAppHint = keyboard === null ? '' : '\n也可以打开 Mini App 的「准入」页填写。';
    const text = `${statusTextOf(ctx.from.id)}${miniAppHint}`;
    await sendBotNotice(ctx, text, keyboard === null ? undefined : { reply_markup: keyboard });
};

const submitApplication = async (ctx: Context, raw: string): Promise<void> => {
    if (!ctx.chat || !ctx.from) return;
    const parsed = splitApplicationText(raw);
    if (parsed === null) {
        await sendBotNotice(ctx, `格式不对。\n${USAGE}`);
        return;
    }
    try {
        const record = await createAccessApplication({
            userId: ctx.from.id,
            chatId: ctx.chat.id,
            messageId: ctx.message?.message_id ?? null,
            identity: parsed.identity,
            purpose: parsed.purpose,
            source: 'command',
        });
        await sendBotNotice(ctx, `已提交准入申请 #${record.id}，等待机主审核。`);
        // Fire and forget: the notice never throws, and the reply is already sent
        void notifyOwnerOfApplication(ctx.api, record);
    } catch (error) {
        if (error instanceof AccessApplicationError) {
            const suffix = error.code === 'invalid' ? `\n${USAGE}` : '';
            await sendBotNotice(ctx, `${error.message}${suffix}`);
            return;
        }
        console.error('[apply] filing the application failed:', error);
        await sendBotNotice(ctx, '提交申请失败，请稍后再试。');
    }
};

/** `/apply`: show the state, or file an application from the argument */
export const registerApplyCommand = (bot: Bot): void => {
    bot.command('apply', async (ctx) => {
        if (!ctx.chat || !ctx.from) return;
        if ((await resolveAccessTier(ctx.from.id, ctx.chat.id)) !== 'trial') {
            await sendBotNotice(ctx, '你已拥有完整功能权限，无需申请。');
            return;
        }
        const raw = (ctx.match ?? '').trim();
        if (raw === '') {
            await replyWithStatus(ctx);
            return;
        }
        await submitApplication(ctx, raw);
    });
};
