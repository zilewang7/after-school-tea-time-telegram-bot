import { useMemo } from 'react';
import { match } from 'ts-pattern';
import type { MediaKind } from '../api';
import { formatBytes } from '../format-metrics';

/** One attachment with the URL its bytes are loaded from (panel signed URL or share route) */
export interface MediaItem {
    kind: MediaKind;
    mimeType: string;
    sizeBytes: number | null;
    // Download name for documents
    fileName: string | null;
    url: string;
}

interface MediaAttachmentViewProps {
    media: MediaItem;
    // Smaller frames inside a tree row
    compact?: boolean;
}

const fileNameOf = (media: MediaItem): string =>
    media.fileName === null || media.fileName === '' ? '文件' : media.fileName;

const sizeLabelOf = (media: MediaItem): string =>
    media.sizeBytes === null ? '' : ` · ${formatBytes(media.sizeBytes)}`;

/**
 * The media of one message: a picture, a looping sticker clip, a playable
 * video / audio file, or a download chip. The URL is already signed / public —
 * this component only decides how it is shown.
 */
export const MediaAttachmentView = ({ media, compact = false }: MediaAttachmentViewProps) => {
    const className = useMemo(() => (compact ? 'media-attachment compact' : 'media-attachment'), [compact]);
    const url = media.url;

    return match(media.kind)
        .with('image', () => (
            <figure className={className}>
                <a href={url} target="_blank" rel="noreferrer">
                    <img className="media-image" src={url} alt="图片" loading="lazy" />
                </a>
            </figure>
        ))
        .with('sticker', () => (
            <figure className={className}>
                <video
                    className="media-sticker"
                    src={url}
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="metadata"
                />
            </figure>
        ))
        .with('video', () => (
            <figure className={className}>
                <video className="media-video" src={url} controls playsInline preload="metadata" />
            </figure>
        ))
        .with('audio', () => (
            <figure className={className}>
                <audio className="media-audio" src={url} controls preload="metadata" />
            </figure>
        ))
        .with('file', () => (
            <a className="media-file" href={url} target="_blank" rel="noreferrer" download={fileNameOf(media)}>
                📎 {fileNameOf(media)}
                {sizeLabelOf(media)}
            </a>
        ))
        .exhaustive();
};
