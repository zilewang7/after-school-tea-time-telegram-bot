/**
 * GET /api/chats/:chatId/conversations/:rootId/export?format=md|json — members
 * only, read-only (never audited). Answers with the file as an attachment;
 * over 5 MB is a 413.
 */
import type { Hono } from 'hono';
import { match, P } from 'ts-pattern';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { PanelError } from '../errors.js';
import { invalid, parseChatId } from '../request.js';
import {
    buildConversationExport,
    renderConversationExport,
    type ExportFormat,
} from '../views/conversation-export.js';
import type { ConversationRouteDeps } from './conversation-deps.js';
import { parseMessageIdParam, requireConversationRoot, requireMember } from './conversation-params.js';

const EXPORT_MAX_BYTES = 5 * 1024 * 1024;

const parseFormat = (raw: string | undefined): ExportFormat =>
    match(raw)
        .returnType<ExportFormat>()
        .with(P.union(undefined, '', 'md'), () => 'md')
        .with('json', () => 'json')
        .otherwise(() => {
            throw invalid('format 只能是 md 或 json');
        });

export const registerConversationExportRoute = (app: Hono<PanelEnv>, deps: ConversationRouteDeps): void => {
    app.get('/api/chats/:chatId/conversations/:rootId/export', async (context) => {
        const auth = requireAuth(context);
        const chatId = parseChatId(context.req.param('chatId'));
        const granted = await requireChatAccess(auth, chatId);
        requireMember(granted);

        const rootId = parseMessageIdParam(context.req.param('rootId'), 'rootId');
        const format = parseFormat(context.req.query('format'));
        await requireConversationRoot(chatId, rootId);

        const exported = await buildConversationExport({
            chat: granted.chat,
            rootId,
            toolApi: deps.toolApi,
            now: new Date(deps.now()),
        });
        const rendered = renderConversationExport(exported, format);
        if (Buffer.byteLength(rendered.body, 'utf8') > EXPORT_MAX_BYTES) {
            throw new PanelError('too_large', '导出内容超过 5 MB');
        }
        return context.body(rendered.body, 200, {
            'Content-Type': rendered.contentType,
            'Content-Disposition': `attachment; filename="${rendered.fileName}"`,
        });
    });
};
