/**
 * workspace: the merged 8-in-1 draft tool (`list | read | write | edit | copy |
 * delete | find | preview`).
 *
 * `leave_handoff` stays a separate tool because the Gemini post-budget handoff
 * round exposes only `leave_handoff`. `preview` is pruned from `action.enum`
 * and `theme` is omitted when `workspacePreview === false`.
 */
import { match } from 'ts-pattern';
import type { ToolHandler } from '../../ai/tools/tool-types.js';
import type { WidgetBudgetLimits } from '../../ai/widget/widget-size.js';
import type { WidgetPrecheckLimits } from '../../telegram/widget-precheck.js';
import type { WorkspaceState } from '../workspace/workspace-state.js';
import {
    DEFAULT_PREVIEW_DEPENDENCIES,
    executeWorkspaceCopy,
    executeWorkspaceDelete,
    executeWorkspaceEdit,
    executeWorkspaceFind,
    executeWorkspaceList,
    executeWorkspacePreview,
    executeWorkspaceRead,
    executeWorkspaceWrite,
    type WorkspaceActionContext,
    type WorkspacePreviewDependencies,
    type WorkspacePreviewRenderResult,
} from './workspace-tool-actions.js';
import { WORKSPACE_TOOL_NAME } from './tool-names.js';
import { workspaceToolError } from './workspace-tool-result.js';
import {
    isWorkspaceAction,
    workspaceDescriptionOf,
    workspaceInputSchemaOf,
    workspaceStatusTextOf,
} from './workspace-tool-schema.js';

export type { WorkspacePreviewDependencies, WorkspacePreviewRenderResult };

export interface WorkspaceToolOptions {
    readonly state: WorkspaceState;
    /** Widget limits of this turn; null/absent = no widget tools, so HTML drafts report plain sizes */
    readonly widgetLimits?: WidgetBudgetLimits | null;
    /** Whether `action='preview'` is offered in schema and accepted at runtime */
    readonly workspacePreview?: boolean;
    /** Required when `workspacePreview` is true */
    readonly previewLimits?: WidgetPrecheckLimits | null;
    readonly previewDependencies?: WorkspacePreviewDependencies;
}

export const createWorkspaceTool = (options: WorkspaceToolOptions): ToolHandler => {
    const previewEnabled = options.workspacePreview === true;
    const context: WorkspaceActionContext = {
        state: options.state,
        widgetLimits: options.widgetLimits ?? null,
        previewEnabled,
        previewLimits: options.previewLimits ?? null,
        previewDependencies: options.previewDependencies ?? DEFAULT_PREVIEW_DEPENDENCIES,
    };
    const allowedActions = previewEnabled
        ? 'list/read/write/edit/copy/delete/find/preview'
        : 'list/read/write/edit/copy/delete/find';

    return {
        definition: {
            name: WORKSPACE_TOOL_NAME,
            description: workspaceDescriptionOf(previewEnabled),
            inputSchema: workspaceInputSchemaOf(previewEnabled),
        },
        statusText: (args) => workspaceStatusTextOf(args),
        execute: async (rawArgs) => {
            const action = rawArgs.action;
            if (!isWorkspaceAction(action)) {
                return workspaceToolError(`参数有误：action 必须是 ${allowedActions} 之一。`);
            }
            return match(action)
                .with('list', () => executeWorkspaceList(rawArgs, context))
                .with('read', () => executeWorkspaceRead(rawArgs, context))
                .with('write', () => executeWorkspaceWrite(rawArgs, context))
                .with('edit', () => executeWorkspaceEdit(rawArgs, context))
                .with('copy', () => executeWorkspaceCopy(rawArgs, context))
                .with('delete', () => executeWorkspaceDelete(rawArgs, context))
                .with('find', () => executeWorkspaceFind(rawArgs, context))
                .with('preview', () => executeWorkspacePreview(rawArgs, context))
                .exhaustive();
        },
    };
};
