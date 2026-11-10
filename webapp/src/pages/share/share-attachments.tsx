import { useMemo } from 'react';
import type { PublicShareMedia } from '../../api';
import { MediaAttachmentView, type MediaItem } from '../../components/media-attachment-view';
import { shareMediaUrlOf, type ShareMediaSlot } from '../../share/share-asset-urls';

interface ShareMediaAttachmentProps {
    token: string;
    messageId: number;
    media: PublicShareMedia;
    // Defaults to the message's own attachment; 'preview' points at a link-preview item
    slot?: ShareMediaSlot;
    index?: number;
}

/** One attachment of the shared content, served by the share's own media route */
export const ShareMediaAttachment = ({ token, messageId, media, slot, index }: ShareMediaAttachmentProps) => {
    const item = useMemo<MediaItem>(() => {
        const resolvedSlot = slot ?? (media.kind === 'file' ? 'file' : 'image');
        return {
            kind: media.kind,
            mimeType: media.mimeType,
            sizeBytes: media.sizeBytes,
            fileName: media.fileName,
            url: shareMediaUrlOf(token, messageId, resolvedSlot, resolvedSlot === 'preview' ? (index ?? 0) : undefined),
        };
    }, [token, messageId, media, slot, index]);
    return <MediaAttachmentView media={item} />;
};
