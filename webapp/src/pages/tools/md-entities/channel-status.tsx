export type CopyStatusTone = 'success' | 'error';

export interface CopyStatus {
    tone: CopyStatusTone;
    message: string;
}

interface ChannelStatusProps {
    status: CopyStatus | null;
}

/** Outcome of the last copy: which clipboard channel actually worked */
export const ChannelStatus = ({ status }: ChannelStatusProps) => {
    if (status === null) return null;
    return <p className={status.tone === 'error' ? 'error-text' : 'success-text'}>{status.message}</p>;
};
