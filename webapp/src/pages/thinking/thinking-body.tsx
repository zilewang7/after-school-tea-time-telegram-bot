import { useCallback, useEffect, useRef } from 'react';

interface ThinkingBodyProps {
    text: string;
    // While the CoT streams, the page follows the new text unless the reader scrolled up
    streaming: boolean;
}

/** How close to the bottom still counts as "following the stream" */
const BOTTOM_SLACK_PX = 48;

const isAtBottom = (): boolean => {
    const root = document.documentElement;
    return root.scrollHeight - window.scrollY - window.innerHeight <= BOTTOM_SLACK_PX;
};

/** The CoT itself: pre-wrap keeps the model's line breaks, and a streaming page follows its tail */
export const ThinkingBody = ({ text, streaming }: ThinkingBodyProps) => {
    const stickToBottomRef = useRef(true);
    const previousLengthRef = useRef(text.length);
    const streamingRef = useRef(streaming);

    const followScrolling = useCallback(() => {
        stickToBottomRef.current = isAtBottom();
    }, []);

    useEffect(() => {
        stickToBottomRef.current = isAtBottom();
        window.addEventListener('scroll', followScrolling, { passive: true });
        return () => window.removeEventListener('scroll', followScrolling);
    }, [followScrolling]);

    useEffect(() => {
        const grew = text.length > previousLengthRef.current;
        const wasStreaming = streamingRef.current;
        previousLengthRef.current = text.length;
        streamingRef.current = streaming;
        // A page opened after the end starts at the top: only a stream (or its last chunk) is followed
        if (!grew || (!streaming && !wasStreaming)) return;
        if (!stickToBottomRef.current) return;
        window.scrollTo({ top: document.documentElement.scrollHeight });
    }, [text, streaming]);

    if (text === '') return <p className="placeholder">正在等待思考内容…</p>;

    return (
        <div className="thinking-body">
            <pre className="thinking-text">{text}</pre>
        </div>
    );
};
