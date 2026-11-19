/**
 * The bot's import surface of the folded Tools block page (design 2026-1119-1835
 * §13.2): generate the page once, store it, and hand the reply a pointer.
 *
 * The final layout asks here only after deciding the Tools block cannot fit one
 * message. This module renders the page and stores it **before returning**, so
 * the link message is never sent for a page that does not exist yet: Telegram's
 * preview crawler fetches once and keeps that card, and a replay of the version
 * reads the same token and therefore the same page.
 *
 * `beginToolLogLink` never throws: a null means the reply falls back to the
 * split block, exactly as before the feature.
 */
import {
    toolLogLinkEnabled,
    toolLogPageLinkOfToken,
    toolLogPageTokenOf,
    type ToolLogPageLink,
} from '../../shared/tool-log-page.js';
import { renderToolLogPage } from './tool-log-page.js';
import { findToolLogPageByToken, insertToolLogPage } from './tool-log-store.js';
import type { BeginToolLogLinkInput } from './tool-log-types.js';

/** The pointer of one version, if its token is well-formed and a public origin exists */
const refOfInput = (input: BeginToolLogLinkInput): ToolLogPageLink | null =>
    toolLogPageLinkOfToken(toolLogPageTokenOf(input));

/**
 * The page of one folded block: existing page reused, otherwise rendered once
 * from the Tools block document and stored before anything is sent. Null when
 * the switch is off, no public origin is configured, or storage fails — the
 * caller then keeps the split block.
 */
export const beginToolLogLink = async (input: BeginToolLogLinkInput): Promise<ToolLogPageLink | null> => {
    if (!toolLogLinkEnabled()) return null;
    const ref = refOfInput(input);
    if (ref === null) return null;
    try {
        const existing = await findToolLogPageByToken(ref.token);
        if (existing !== null) return ref;
        const html = renderToolLogPage({
            model: input.model,
            createdAt: input.createdAt,
            document: input.document,
        });
        await insertToolLogPage({
            token: ref.token,
            chatId: input.chatId,
            firstMessageId: input.firstMessageId,
            versionId: input.versionId,
            model: input.model,
            createdAt: input.createdAt,
            html,
        });
        return ref;
    } catch (error) {
        console.warn(
            `[tool-log] generating the page of ${input.chatId}:${input.firstMessageId}:${input.versionId} failed:`,
            error
        );
        return null;
    }
};
