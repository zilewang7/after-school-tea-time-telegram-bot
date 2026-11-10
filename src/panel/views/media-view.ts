/**
 * The media references a panel page needs: the descriptor plus the signed URL
 * the browser loads. Members reach user-message media; observers' user nodes
 * carry none (their bot nodes follow the same rules as members').
 */
import type { ContextMessage } from '../../db/queries/context-queries.js';
import type { SignedMediaSigner } from '../share/signed-media.js';
import {
    loadMessageMediaDescriptors,
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

/** One batched lookup and signing of the user messages' media (tree / flat view) */
export const loadMessageMediaViews = async (
    signer: SignedMediaSigner,
    chatId: number,
    messages: readonly ContextMessage[]
): Promise<Map<number, MediaView>> => {
    const descriptors = await loadMessageMediaDescriptors(messages);
    const views = new Map<number, MediaView>();
    for (const [messageId, descriptor] of descriptors) {
        views.set(messageId, toMediaView(signer, chatId, messageId, null, descriptor));
    }
    return views;
};
