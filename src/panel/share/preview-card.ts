/**
 * The 1200×630 preview card of a share (design §5.7): pick the content, render
 * it through the widget-image renderer, and hand back the PNG for storage.
 *
 * No renderer means no card, never a broken page: the share page omits the OG
 * image and Telegram shows a text-only preview (design §9).
 */
import {
    isWidgetRenderConfigured,
    renderShareCard,
    renderWidgetPng,
    type ShareCardInput,
    type RenderResult,
} from '../../widget-image/index.js';
import type { PreviewImage, PreviewSnapshot, PreviewSource } from './share-types.js';

const CARD_TEXT_MAX = 180;
const CARD_SUBTITLE_MAX = 60;
/** The widget snapshot is re-rendered at the card's own width (design §5.7) */
const CARD_WIDGET_WIDTH = 1200;
const SHARE_TIME_ZONE = 'Asia/Shanghai';

const bufferOfBase64 = (base64: string | undefined): Buffer | undefined =>
    base64 === undefined || base64 === '' ? undefined : Buffer.from(base64, 'base64');

const excerptOf = (text: string, maxLength: number): string | undefined => {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat === '') return undefined;
    return flat.length <= maxLength ? flat : `${flat.slice(0, Math.max(1, maxLength - 1))}…`;
};

/** `2026-11-09 21:30` in the bot's time zone (the card footer) */
export const formatShareTime = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: SHARE_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const valueOf = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((part) => part.type === type)?.value ?? '';
    return `${valueOf('year')}-${valueOf('month')}-${valueOf('day')} ${valueOf('hour')}:${valueOf('minute')}`;
};

/** Which content the card would show; null when there is nothing to draw */
export const previewSourceOf = (snapshot: PreviewSnapshot): PreviewSource | null => {
    if (snapshot.widgetHtml !== undefined || snapshot.widgetImageBase64 !== undefined) return 'widget';
    if (snapshot.imageBase64 !== undefined) return 'image';
    return excerptOf(snapshot.text, CARD_TEXT_MAX) === undefined ? null : 'text';
};

/**
 * The card's texts. Media buffers are rendered separately (renderPreviewImage);
 * without them this is exactly what a text card shows, which is what the
 * offline cases assert.
 */
export const buildShareCardInput = (
    snapshot: PreviewSnapshot,
    media: { widgetPng?: Buffer; imagePng?: Buffer } = {}
): ShareCardInput => {
    const chatTitle = snapshot.chatTitle ?? '';
    const title = chatTitle === '' ? '来自 k-on-bot 的分享' : `来自「${chatTitle}」的分享`;
    const subtitle =
        excerptOf(snapshot.text, CARD_SUBTITLE_MAX) ?? excerptOf(snapshot.caption ?? '', CARD_SUBTITLE_MAX);
    const time = formatShareTime(snapshot.createdAt);
    const footer = [chatTitle, time].filter((part) => part !== '').join(' · ');
    const textExcerpt = excerptOf(snapshot.text, CARD_TEXT_MAX);
    return {
        title,
        ...(subtitle === undefined ? {} : { subtitle }),
        ...(footer === '' ? {} : { footer }),
        ...(media.widgetPng === undefined ? {} : { widgetPng: media.widgetPng }),
        ...(media.imagePng === undefined ? {} : { imagePng: media.imagePng }),
        ...(textExcerpt === undefined ? {} : { textExcerpt }),
    };
};

interface WidgetSnapshot {
    png: Buffer;
    /** false when the stored 600px render stands in for a fresh 1200 one */
    rendered: boolean;
}

/** The widget snapshot at card width; falls back to the stored 600px render */
const renderWidgetSnapshot = async (snapshot: PreviewSnapshot): Promise<WidgetSnapshot | undefined> => {
    if (snapshot.widgetHtml !== undefined) {
        const rendered = await renderWidgetPng(snapshot.widgetHtml, {
            width: CARD_WIDGET_WIDTH,
            scale: 1,
            theme: 'dark',
        });
        if (rendered !== null) return { png: rendered.png, rendered: true };
    }
    const stored = bufferOfBase64(snapshot.widgetImageBase64);
    return stored === undefined ? undefined : { png: stored, rendered: false };
};

/** Render the preview card; null when the renderer is off or failed */
export const renderPreviewImage = async (snapshot: PreviewSnapshot): Promise<PreviewImage | null> => {
    const source = previewSourceOf(snapshot);
    if (source === null) return null;
    if (!isWidgetRenderConfigured()) return null;

    const widget = await renderWidgetSnapshot(snapshot);
    const imagePng = bufferOfBase64(snapshot.imageBase64);
    const rendered: RenderResult | null = await renderShareCard(
        buildShareCardInput(snapshot, {
            ...(widget === undefined ? {} : { widgetPng: widget.png }),
            ...(imagePng === undefined ? {} : { imagePng }),
        })
    );
    if (rendered === null) return null;
    // The template skips oversized images and falls back to the text excerpt;
    // the stored source names the content we handed it (debugging only)
    const shownSource: PreviewSource =
        widget === undefined ? (imagePng === undefined ? 'text' : 'image') : widget.rendered ? 'widget' : 'raw-widget';
    return {
        base64: rendered.png.toString('base64'),
        width: rendered.width,
        height: rendered.height,
        source: shownSource,
    };
};
