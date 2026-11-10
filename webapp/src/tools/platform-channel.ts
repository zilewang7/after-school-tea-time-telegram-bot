/**
 * Which copy channel a platform should offer. The platform matrix is the one
 * from the design doc: the HTML clipboard works on tdesktop/Android/Web, iOS
 * needs the markdown channel (its client converts markdown on paste), macOS
 * native is unverified and gets the markdown channel with a warning.
 */
import type { ChannelPlan, ClientPlatform, ClipboardTarget, RichChannel } from './types';

const PLATFORM_ALIASES: Readonly<Record<string, ClientPlatform>> = {
    android: 'android',
    ios: 'ios',
    ipad: 'ios',
    iphone: 'ios',
    macos: 'macos',
    tdesktop: 'tdesktop',
    web: 'web',
    weba: 'web',
    webk: 'web',
};

export const resolveClientPlatform = (raw: string | undefined): ClientPlatform => {
    if (raw === undefined) return 'unknown';
    return PLATFORM_ALIASES[raw.trim().toLowerCase()] ?? 'unknown';
};

export const resolveClipboardTarget = (platform: ClientPlatform): ClipboardTarget => {
    if (platform === 'android') return 'android';
    if (platform === 'web') return 'web';
    return 'desktop';
};

interface ChannelCopy {
    recommended: RichChannel;
    dialect: 'ios' | 'telegram';
    note: string;
}

const channelCopyOf = (platform: ClientPlatform, htmlSupported: boolean): ChannelCopy => {
    if (platform === 'android') {
        return {
            recommended: htmlSupported ? 'rich-html' : 'plain',
            dialect: 'telegram',
            note: 'Android 支持富文本粘贴：行内代码会变成普通文字，多行代码块已按 Android 的换行规则处理。',
        };
    }
    if (platform === 'ios') {
        return {
            recommended: 'markdown',
            dialect: 'ios',
            note: 'iOS 客户端在粘贴 Markdown 时会自动转成格式；剧透会退化为普通文字。',
        };
    }
    if (platform === 'macos') {
        return {
            recommended: 'markdown',
            dialect: 'ios',
            note: 'macOS 原生客户端对 HTML 剪贴板支持有限，Markdown 通道也可能不生效；建议使用桌面版 Telegram。',
        };
    }
    if (platform === 'web') {
        return {
            recommended: htmlSupported ? 'rich-html' : 'plain',
            dialect: 'telegram',
            note: '浏览器版支持富文本粘贴；若浏览器拦截剪贴板，可改用 Markdown 文本通道。',
        };
    }
    if (platform === 'tdesktop') {
        return {
            recommended: htmlSupported ? 'rich-html' : 'plain',
            dialect: 'telegram',
            note: '桌面版支持富文本粘贴：复制后到输入框粘贴即可；代码块语言会丢失，折叠引用会退化为普通引用。',
        };
    }
    return {
        recommended: htmlSupported ? 'rich-html' : 'markdown',
        dialect: 'telegram',
        note: '未识别客户端：先试富文本，失败再试 Markdown 文本。',
    };
};

export const channelPlanOf = (platform: ClientPlatform, htmlSupported: boolean): ChannelPlan => {
    const copy = channelCopyOf(platform, htmlSupported);
    return {
        platform,
        target: resolveClipboardTarget(platform),
        recommended: copy.recommended,
        markdownDialect: copy.dialect,
        htmlSupported,
        note: copy.note,
    };
};
