/**
 * Shared types of the clipboard converter. No DOM and no React here: the same
 * modules are imported by the offline tests.
 */
import type { MessageEntity } from 'telegram-md-entities';

/** The client the Mini App runs in (Telegram.WebApp.platform, normalized) */
export type ClientPlatform = 'tdesktop' | 'android' | 'ios' | 'macos' | 'web' | 'unknown';

/** Which HTML dialect the generator emits for the paste target */
export type ClipboardTarget = 'desktop' | 'android' | 'web';

/** The copy channel recommended for a platform */
export type RichChannel = 'rich-html' | 'markdown' | 'plain';

/** Which plain-text markdown dialect the markdown channel writes */
export type MarkdownDialect = 'ios' | 'telegram';

/** One rendered markdown document: plain text plus Bot API entities */
export interface RenderedMarkdown {
    text: string;
    entities: MessageEntity[];
}

/** What a rich copy writes to the clipboard */
export interface ClipboardPayload {
    html: string;
    plainText: string;
}

/** Where a parsed clipboard HTML came from */
export type ParsedSource = 'webk-json' | 'html';

/** Result of parsing HTML copied out of a Telegram client */
export interface ParsedClipboard {
    text: string;
    entities: MessageEntity[];
    /** Tags that carried formatting this converter cannot express (shown in the UI) */
    ignoredTags: string[];
    source: ParsedSource;
}

/** Result of the reverse direction, ready for the UI */
export interface ClipboardConversion {
    markdown: string;
    text: string;
    entities: MessageEntity[];
    ignoredTags: string[];
    source: ParsedSource;
}

/** How the tool should present the copy buttons for the current platform */
export interface ChannelPlan {
    platform: ClientPlatform;
    target: ClipboardTarget;
    recommended: RichChannel;
    /** Which markdown dialect the "copy markdown" button uses for this platform */
    markdownDialect: MarkdownDialect;
    /** True when the WebView can put text/html on the clipboard */
    htmlSupported: boolean;
    /** One-line guidance shown under the copy buttons */
    note: string;
}
