import { useParams } from 'react-router';

const POSITIVE_INTEGER = /^\d{1,15}$/;

const readPositiveInteger = (raw: string | undefined): number | null => {
    if (raw === undefined || !POSITIVE_INTEGER.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
};

/** :rootId of a conversation route */
export const useRootIdParam = (): number | null => {
    const params = useParams();
    return readPositiveInteger(params.rootId);
};

/** :firstMessageId of a reply route */
export const useFirstMessageIdParam = (): number | null => {
    const params = useParams();
    return readPositiveInteger(params.firstMessageId);
};
