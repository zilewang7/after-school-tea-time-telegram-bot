import { useEffect, useState } from 'react';
import type { ChatSummary } from '../api';
import { useApi } from '../context/panel-context';

/** How long the share page waits for /api/me before showing the read-only view anyway */
const VIEWER_LOOKUP_TIMEOUT_MS = 5000;

export type ViewerChatsState =
    | { status: 'loading' }
    // chats: null when /api/me failed; the page then stays read-only
    | { status: 'done'; chats: readonly ChatSummary[] | null };

/**
 * The viewer's chat list, only to decide whether a share should open the
 * panel's own page (every listed chat is one the viewer may open). Failure or
 * slowness is not an error: the public content must render either way.
 */
export const useViewerChats = (): ViewerChatsState => {
    const api = useApi();
    const [state, setState] = useState<ViewerChatsState>({ status: 'loading' });

    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), VIEWER_LOOKUP_TIMEOUT_MS);
        void api.getMe(controller.signal).then((result) => {
            if (cancelled) return;
            setState({ status: 'done', chats: result.ok ? result.data.chats : null });
        });
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [api]);

    return state;
};
