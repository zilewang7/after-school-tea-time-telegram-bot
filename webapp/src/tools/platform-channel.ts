/**
 * Which copy channel a platform should offer. The platform matrix is the one
 * from the design doc: the HTML clipboard works on tdesktop/Android/Web and iOS
 * needs the markdown channel (its client converts markdown on paste). The
 * native macOS client does neither, so no channel is recommended there.
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
    /** null: no copy channel is known to work for this client */
    recommended: RichChannel | null;
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
            recommended: null,
            dialect: 'ios',
            note: 'macOS 原生客户端两个通道都不可用；请改用桌面版 Telegram。',
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
            note: '桌面版支持富文本粘贴：复制后到输入框粘贴即可；代码块语言会丢失，折叠引用会按普通引用导入，粘贴后可在输入框里手动切换成折叠。',
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

/** What the reverse direction can get out of each client's clipboard */
const REVERSE_NOTES: Readonly<Record<ClientPlatform, string>> = {
    tdesktop: 'Desktop 复制消息时会写入 HTML，粘贴到这里即可还原格式。代码块的语言名在导出时丢失，属正常。',
    android:
        'Android 复制消息时会写入 HTML，粘贴到这里即可还原。注意 Android 不认行内代码，那部分会变成普通文字。',
    ios: 'iOS 复制消息时不写 HTML，只能拿到纯文本 —— 这是客户端限制，不是本工具的问题。',
    macos: 'macOS 原生客户端复制消息时不写 HTML，只能拿到纯文本 —— 这是客户端限制，不是本工具的问题。',
    web: 'Telegram 网页版复制消息时会写入 HTML（WebK 还会带上精确实体 JSON），粘贴到这里即可还原。',
    unknown: '',
};

/** One-line guidance for direction 2 on the client the clipboard came from */
export const reverseNoteOf = (platform: ClientPlatform): string => REVERSE_NOTES[platform];
