/**
 * /web: hand the caller a one-time code for the browser login (design §4.1).
 *
 * Private chats only — a code posted into a group is a code anyone can spend.
 * The message itself is never written to the message table (unlike
 * sendBotNotice): it contains a live credential, and /chat context must not
 * replay it into the model.
 */
import { Bot } from 'grammy';
import { webLoginBotChatLink, webLoginEnabled, webLoginMiniAppLink, webLoginPublicUrl } from '../../config/web-login.js';
import { isPanelRunning } from '../../panel/panel-state.js';
import { getWebAuthRuntime } from '../../panel/auth/web-auth-runtime.js';
import { formatWebLoginCode } from '../../panel/auth/web-login-code.js';

const CODE_TTL_MINUTES = 5;

const loginText = (code: string): string => {
    const publicUrl = webLoginPublicUrl();
    const miniAppUrl = webLoginMiniAppLink();
    return [
        `网页版身份码：\`${formatWebLoginCode(code)}\`（${CODE_TTL_MINUTES} 分钟内有效，一次性）`,
        '',
        `浏览器打开 ${publicUrl === '' ? '控制面板' : publicUrl} 输入它即可登录。`,
        ...(miniAppUrl === null ? [] : ['', `也可以直接在 Telegram 里打开面板：${miniAppUrl}`]),
    ].join('\n');
};

const groupText = (): string => {
    const botChatLink = webLoginBotChatLink();
    return botChatLink === null
        ? '身份码只能在和我的私聊里获取。'
        : `身份码只能在私聊里获取：${botChatLink}`;
};

export const registerWebCommand = (bot: Bot) => {
    bot.command('web', async (context) => {
        if (!webLoginEnabled() || !isPanelRunning()) {
            await context.reply('网页版登录未启用');
            return;
        }
        if (context.chat.type !== 'private') {
            await context.reply(groupText());
            return;
        }
        const userId = context.from?.id;
        if (userId === undefined) {
            await context.reply('无法识别你的账号，请稍后再试');
            return;
        }
        const issued = getWebAuthRuntime().codes.issue(userId);
        if (!issued.ok) {
            await context.reply(`获取太频繁了，${issued.retryAfterSeconds} 秒后再试`);
            return;
        }
        console.log(`[web-login] code issued user=${userId}`);
        await context.reply(loginText(issued.code), { parse_mode: 'Markdown' });
    });
};
