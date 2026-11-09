import type { PublicShareFile } from '../../api';
import { formatBytes } from '../../format-metrics';
import { shareMediaUrlOf } from '../../share/share-asset-urls';

interface ShareImageProps {
    token: string;
    messageId: number;
    alt: string;
}

/** One image of the shared content, served by the share's own media route */
export const ShareImage = ({ token, messageId, alt }: ShareImageProps) => (
    <img className="share-image" src={shareMediaUrlOf(token, messageId, 'image')} alt={alt} loading="lazy" />
);

interface ShareFileLinkProps {
    token: string;
    messageId: number;
    file: PublicShareFile;
}

/** A shared text file: a plain download link, no action of its own */
export const ShareFileLink = ({ token, messageId, file }: ShareFileLinkProps) => (
    <a
        className="share-file"
        href={shareMediaUrlOf(token, messageId, 'file')}
        target="_blank"
        rel="noreferrer"
        download={file.name}
    >
        📎 {file.name} · {formatBytes(file.sizeBytes)}
    </a>
);
