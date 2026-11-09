/**
 * The preview image of a share (design §5.7): the shared widget's own render at
 * the page's 1200px width, light theme, cropped to its content height. It is
 * stored as `/s/<token>/og.png` and is what Telegram's large photo preview
 * shows; a share without a widget has no image at all, so its page keeps the
 * text OG (design §9).
 *
 * No renderer means no image, never a broken page.
 */
import { isWidgetRenderConfigured, renderWidgetPng } from '../../widget-image/index.js';
import type { PreviewImage, PreviewSnapshot } from './share-types.js';

/** The image is the widget itself, not a composed card; 1200 is the large-photo width */
const PREVIEW_WIDTH = 1200;

/** Render the share's preview image; null when there is no widget or rendering failed */
export const renderPreviewImage = async (snapshot: PreviewSnapshot): Promise<PreviewImage | null> => {
    if (!isWidgetRenderConfigured()) return null;
    const html = snapshot.widgetHtml;
    if (html === undefined) return null;
    const rendered = await renderWidgetPng(html, { width: PREVIEW_WIDTH, scale: 1, theme: 'light' });
    if (rendered === null) return null;
    return {
        base64: rendered.png.toString('base64'),
        width: rendered.width,
        height: rendered.height,
        source: 'widget',
    };
};
