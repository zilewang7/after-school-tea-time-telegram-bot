/**
 * The media references a panel page needs: the descriptor plus the signed URL
 * the browser loads. Members reach user-message media; observers' user nodes
 * carry none (their bot nodes follow the same rules as members').
 */
import type { ContextMessage } from '../../db/queries/context-queries.js';
import type { SignedMediaSigner } from '../share/signed-media.js';
import {
    loadMessageAlbumMedia,
    type MediaDescriptor,
    type PreviewMediaDescriptor,
} from '../media/media-content.js';

/** One attachment as a panel page renders it; `url` is a signed `/m/…` path */
export interface MediaView extends MediaDescriptor {
    url: string;
}

/** Descriptor plus the `/m/…` path for it; a version id makes it a `ver` token */
export const toMediaView = (
    signer: SignedMediaSigner,
    chatId: number,
    messageId: number,
    versionId: number | null,
    descriptor: MediaDescriptor
): MediaView => ({
    ...descriptor,
    url: signer.sign({
        chatId,
        messageId,
        ...(versionId === null ? {} : { versionId }),
        kind: versionId === null ? 'msg' : 'ver',
    }).path,
});

/** The signed views of a message's captured link-preview attachments */
export const toPreviewMediaViews = (
    signer: SignedMediaSigner,
    chatId: number,
    messageId: number,
    previews: readonly PreviewMediaDescriptor[]
): MediaView[] =>
    previews.map((preview) => ({
        kind: preview.kind,
        mimeType: preview.mimeType,
        sizeBytes: preview.sizeBytes,
        fileName: preview.fileName,
        url: signer.sign({ chatId, messageId, kind: 'cache', mediaKey: preview.mediaKey }).path,
    }));

/**
 * One batched lookup and signing of the user messages' media (tree / flat
 * view): every item of a bubble signs its own message id, so a Telegram album's
 * extra items load through their own `/m/…` URLs.
 */
export const loadMessageMediaViews = async (
    signer: SignedMediaSigner,
    chatId: number,
    messages: readonly ContextMessage[]
): Promise<Map<number, MediaView[]>> => {
    const albumMedia = await loadMessageAlbumMedia(chatId, messages);
    const views = new Map<number, MediaView[]>();
    for (const [messageId, items] of albumMedia) {
        views.set(
            messageId,
            items.map((item) => toMediaView(signer, chatId, item.messageId, null, item.descriptor))
        );
    }
    return views;
};
