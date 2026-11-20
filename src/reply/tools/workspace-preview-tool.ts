/**
 * workspace_preview: render an HTML / A2UI draft and show the model what it
 * looks like.
 *
 * A widget is immutable once sent, so the only way to iterate is to look before
 * sending. The render sidecar already exists (share previews, widget context
 * images); this tool is the missing step that brings the PNG back into the
 * model's context. It also reports the widget size budget and the precheck
 * result, which is what the model needs to know before `send_widget`.
 *
 * One call may preview several drafts (`paths`, up to three): they render one
 * after another in request order, every successful picture rides the same tool
 * result, and a draft that fails to render is reported alone.
 */
import type { ToolHandler, ToolModelImage, ToolResult } from '../../ai/tools/tool-types.js';
import { compileA2uiSurface } from '../../ai/widget/index.js';
import { measureWidgetHtml } from '../../ai/widget/widget-size.js';
import { baseNameOf, extensionOf, formatBytes } from '../../shared/file-name.js';
import { readWorkspaceFile, touchWorkspaceFile } from '../../services/workspace-service.js';
import { precheckWidgetHtml, type WidgetPrecheckLimits } from '../../telegram/widget-precheck.js';
import { renderWidgetPng } from '../../widget-image/render-client.js';
import { widgetDocument } from '../../widget-image/widget-page.js';
import { resolveWorkspaceRef, type WorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import {
    parseWorkspacePreviewArgs,
    parseWorkspacePreviewBatchArgs,
    type PreviewTheme,
    PREVIEW_BATCH_MAX,
} from './workspace-tool-args.js';
import {
    logWorkspaceBatchFailures,
    workspaceBatchFailureLine,
    workspaceBatchTraceArgument,
    workspaceToolError,
    workspaceToolSuccess,
} from './workspace-tool-result.js';
import { WORKSPACE_PREVIEW_TOOL_NAME } from './tool-names.js';
import { traceParts, traceWorkspacePath } from './tool-trace.js';

const DESCRIPTION =
    '把工作区里的 HTML/A2UI 草稿渲染成 600px 宽的图片给你自己看（静态首帧），同时报告体积与 widget 预检结果。' +
    '发送前用它检查布局/配色/溢出与体积。支持 .html/.htm 与 A2UI surface 的 .json；渲染需要 1–3 秒。' +
    `一次预览多个草稿用 paths（最多 ${PREVIEW_BATCH_MAX} 个）；theme/workspace 对全部适用，每张成功的图都会附上。`;

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        path: { type: 'string', description: '工作区里的 .html/.htm 或 A2UI surface 的 .json 路径。' },
        theme: {
            type: 'string',
            enum: ['light', 'dark'],
            description: '预览用的配色，默认 light。',
        },
        workspace: {
            type: 'string',
            description: '要操作哪个会话的工作区：省略=当前会话（w1）；w2、w3… 见运行时工作区清单。',
        },
        paths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: PREVIEW_BATCH_MAX,
            description: `一次预览多个草稿：最多 ${PREVIEW_BATCH_MAX} 个路径，与 path 二选一；按列表顺序渲染。`,
        },
    },
    // Either path or paths; the parser states which fields belong together
    required: [],
};

/** The render sidecar's default HTML cap (widget-render/server.mjs MAX_HTML_BYTES); keep in sync if that env changes */
const MAX_PREVIEW_DOCUMENT_BYTES = 300 * 1024;
/** Preview viewport: the Telegram bubble's layout width */
const PREVIEW_WIDTH = 600;

export interface WorkspacePreviewRenderResult {
    readonly png: Buffer;
    readonly width: number;
    readonly height: number;
}

export interface WorkspacePreviewDependencies {
    /** Injected so the offline suite can answer with a PNG without the sidecar */
    readonly renderPng: (
        document: string,
        options: { readonly width: number; readonly theme: 'light' | 'dark' }
    ) => Promise<WorkspacePreviewRenderResult | null>;
}

const DEFAULT_DEPENDENCIES: WorkspacePreviewDependencies = {
    renderPng: (document, options) =>
        renderWidgetPng(document, { width: options.width, theme: options.theme }),
};

const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(`[workspace_preview] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return workspaceToolError(message);
};

export interface WorkspacePreviewToolOptions {
    readonly state: WorkspaceState;
    readonly limits: WidgetPrecheckLimits;
    readonly dependencies?: WorkspacePreviewDependencies;
}

type DraftRenderOutcome =
    | {
          readonly ok: true;
          readonly content: string;
          readonly modelImage: ToolModelImage;
          readonly width: number;
          readonly height: number;
          readonly precheckOk: boolean;
      }
    | { readonly ok: false; readonly error: string };

export const createWorkspacePreviewTool = (options: WorkspacePreviewToolOptions): ToolHandler => {
    const { state, limits } = options;
    const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;

    /** One draft: read, compile, measure, render; every failure is a sentence for the item */
    const renderDraft = async (
        ref: WorkspaceRef,
        path: string,
        theme: PreviewTheme
    ): Promise<DraftRenderOutcome> => {
        const file = await readWorkspaceFile(state.chatId, ref.rootId, path);
        if (file === null) {
            return { ok: false, error: `工作区里没有《${path}》。用 workspace_list 看看现有文件。` };
        }
        await touchWorkspaceFile(file.id).catch((error: unknown) => {
            console.warn('[workspace_preview] lastUsedAt refresh failed:', error);
        });

        const extension = extensionOf(baseNameOf(file.path));
        let html: string;
        // The precheck runs against the delivery mode the draft would be sent
        // in: an A2UI draft is compiled to HTML first, so it must not be
        // judged by the HTML-mode switch.
        let mode: 'html' | 'a2ui';
        if (extension === 'html' || extension === 'htm') {
            html = file.content;
            mode = 'html';
        } else if (extension === 'json') {
            let surface: unknown;
            try {
                surface = JSON.parse(file.content);
            } catch {
                return { ok: false, error: `《${file.path}》不是合法的 JSON；A2UI 草稿要写成合法的 surface JSON。` };
            }
            const compiled = compileA2uiSurface(surface, {
                maxHtmlBytes: limits.maxHtmlBytes,
                maxGzipBytes: limits.maxGzipBytes,
            });
            if (!compiled.ok) {
                return { ok: false, error: `A2UI 草稿编译失败：${compiled.message}` };
            }
            html = compiled.html;
            mode = 'a2ui';
        } else {
            return {
                ok: false,
                error: 'workspace_preview 只支持 .html/.htm（HTML 草稿）或 .json（A2UI surface）；文本请用 workspace_read。',
            };
        }

        const document = widgetDocument(html, { theme });
        if (Buffer.byteLength(document, 'utf8') > MAX_PREVIEW_DOCUMENT_BYTES) {
            return {
                ok: false,
                error:
                    `《${file.path}》包裹成完整文档后有 ${formatBytes(Buffer.byteLength(document, 'utf8'))}，` +
                    `超过渲染边车上限 ${formatBytes(MAX_PREVIEW_DOCUMENT_BYTES)}；请精简内容或拆成多个文件。`,
            };
        }

        const rendered = await dependencies.renderPng(document, { width: PREVIEW_WIDTH, theme });
        if (rendered === null) {
            return {
                ok: false,
                error: '预览渲染不可用或失败（边车未配置/超时）；可以直接 send_widget 发送，或用 workspace_read 检查源码。',
            };
        }

        const size = measureWidgetHtml(html);
        const precheck = precheckWidgetHtml(mode, html, limits);
        const budget =
            `体积：原文 ${formatBytes(size.rawBytes)} / ${formatBytes(limits.maxHtmlBytes)}，` +
            `zlib9 ${formatBytes(size.zlibBytes)} / ${formatBytes(limits.maxGzipBytes)}`;
        const precheckLine = precheck.ok
            ? 'widget 预检：通过。'
            : `widget 预检：不通过——${precheck.message}`;
        const label = `${ref.label} ${ref.token}`;
        return {
            ok: true,
            content:
                `已渲染《${file.path}》（${label}）预览：${rendered.width}×${rendered.height} PNG，已附上（静态首帧）。` +
                `${budget}；${precheckLine}`,
            modelImage: {
                data: rendered.png,
                mimeType: 'image/png',
                caption: `[workspace_preview] ${file.path}`,
            },
            width: rendered.width,
            height: rendered.height,
            precheckOk: precheck.ok,
        };
    };

    const executeBatch = async (rawArgs: Readonly<Record<string, unknown>>): Promise<ToolResult> => {
        const parsed = parseWorkspacePreviewBatchArgs(rawArgs);
        if (!parsed.ok) return reject(parsed.error);
        const ref = resolveWorkspaceRef(state, parsed.value.workspace);
        if (!ref.ok) return reject(ref.error);
        const requestLabels = parsed.value.items.map((item) =>
            item.ok ? traceWorkspacePath(ref.ref.token, item.path) : item.label
        );
        const paragraphs: string[] = [];
        const modelImages: ToolModelImage[] = [];
        const failures: string[] = [];

        for (const item of parsed.value.items) {
            if (!item.ok) {
                failures.push(workspaceBatchFailureLine(item.label, item.error));
                continue;
            }
            const rendered = await renderDraft(ref.ref, item.path, parsed.value.theme);
            if (!rendered.ok) {
                failures.push(
                    workspaceBatchFailureLine(traceWorkspacePath(ref.ref.token, item.path), rendered.error)
                );
                continue;
            }
            paragraphs.push(rendered.content);
            modelImages.push(rendered.modelImage);
        }

        logWorkspaceBatchFailures(WORKSPACE_PREVIEW_TOOL_NAME, failures);
        const lines: string[] = [];
        if (paragraphs.length > 0) {
            lines.push(`已渲染 ${paragraphs.length} 张预览：`);
            lines.push(paragraphs.join('\n\n'));
        }
        if (failures.length > 0) {
            lines.push(
                paragraphs.length > 0
                    ? `有 ${failures.length} 个没渲染成：`
                    : `这 ${parsed.value.items.length} 个草稿都没渲染成：`
            );
            for (const failure of failures) lines.push(`- ${failure}`);
        }
        const trace = {
            argument: workspaceBatchTraceArgument('个草稿', requestLabels),
            result:
                paragraphs.length === 0
                    ? '全部失败'
                    : traceParts(`${paragraphs.length} 张`, failures.length > 0 ? `${failures.length} 个失败` : null),
        };
        return paragraphs.length === 0
            ? workspaceToolError(lines.join('\n'), trace)
            : workspaceToolSuccess(lines.join('\n'), modelImages, trace);
    };

    return {
        definition: {
            name: WORKSPACE_PREVIEW_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '🖼️ 正在渲染工作区预览…',
        execute: async (rawArgs) => {
            const singleGiven = typeof rawArgs.path === 'string' && rawArgs.path.trim() !== '';
            const paths = rawArgs.paths;
            if (Array.isArray(paths) && (paths.length > 0 || !singleGiven)) return executeBatch(rawArgs);

            const parsed = parseWorkspacePreviewArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const ref = resolveWorkspaceRef(state, rawArgs.workspace);
            if (!ref.ok) return reject(ref.error);

            const rendered = await renderDraft(ref.ref, parsed.value.path, parsed.value.theme);
            if (!rendered.ok) return reject(rendered.error);
            return workspaceToolSuccess(rendered.content, [rendered.modelImage], {
                argument: traceParts(
                    traceWorkspacePath(ref.ref.token, parsed.value.path),
                    parsed.value.theme === 'dark' ? 'dark' : null
                ),
                result: `${rendered.width}×${rendered.height} PNG · ${rendered.precheckOk ? '预检通过' : '预检不通过'}`,
            });
        },
    };
};
