/**
 * Matching a `-w=` against the workflow list the server declares.
 *
 * Shared by `/pic` and `/vid` because the matching rules (exact id, then a
 * unique prefix, then a helpful list) have nothing to do with what the
 * workflow produces.
 */
import { match } from 'ts-pattern';
import {
    mediaKindOfWorkflow,
    type ComfyWorkflow,
    type GenerationMediaKind,
} from '../../services/comfy-forward-service.js';

export type WorkflowMatch =
    | { ok: true; workflow: ComfyWorkflow }
    | { ok: false; reason: string };

/** `` `a`、`b`、`c` `` — for "now on offer:" lines */
export const describeWorkflows = (workflows: ComfyWorkflow[]): string =>
    workflows.map((workflow) => `\`${workflow.id}\``).join('、');

/**
 * Exact id wins, then a unique prefix — `-w=flux2` should not need the whole
 * `flux2-klein-9b-base-edit`, but an ambiguous prefix must say so rather than
 * silently picking one.
 */
export const matchWorkflowByQuery = (
    workflows: ComfyWorkflow[],
    query: string
): WorkflowMatch => {
    const lowered = query.toLowerCase();

    const exact = workflows.find((workflow) => workflow.id.toLowerCase() === lowered);
    if (exact) return { ok: true, workflow: exact };

    const prefixed = workflows.filter((workflow) => workflow.id.toLowerCase().startsWith(lowered));
    if (prefixed.length === 1) return { ok: true, workflow: prefixed[0]! };
    if (prefixed.length > 1) {
        return {
            ok: false,
            reason: `\`-w=${query}\` 能对上好几个工作流：${describeWorkflows(prefixed)}`,
        };
    }

    // A substring match is the last resort: workflow ids are getting longer
    // (`minimax-h3-turbo`), and `-w=h3` is the obvious thing to type
    const contained = workflows.filter((workflow) => workflow.id.toLowerCase().includes(lowered));
    if (contained.length === 1) return { ok: true, workflow: contained[0]! };
    if (contained.length > 1) {
        return {
            ok: false,
            reason: `\`-w=${query}\` 能对上好几个工作流：${describeWorkflows(contained)}`,
        };
    }

    return {
        ok: false,
        reason: `没有叫 \`${query}\` 的工作流。现在有：${describeWorkflows(workflows)}`,
    };
};

/** "that one belongs to the other command" — worth saying instead of "not found" */
const wrongKindReason = (workflow: ComfyWorkflow, wanted: GenerationMediaKind): string =>
    match(wanted)
        .with('video', () => `\`${workflow.id}\` 是出图的工作流，出图请用 /pic`)
        .with('image', () => `\`${workflow.id}\` 是出视频的工作流，出视频请用 /vid`)
        .exhaustive();

/**
 * `-w=` inside a command that only makes one kind of media. The candidates are
 * that kind's workflows alone: `-w=base` from `/vid` means `minimax-h3-base`,
 * and `flux2-klein-9b-base-edit` is not a rival for it — it was never something
 * `/vid` could run. The full list is consulted only to explain a query that
 * named the other command's workflow.
 */
export const matchWorkflowOfKind = (
    workflows: ComfyWorkflow[],
    query: string,
    wanted: GenerationMediaKind
): WorkflowMatch => {
    const isWanted = (workflow: ComfyWorkflow): boolean =>
        mediaKindOfWorkflow(workflow.kind) === wanted;

    const matched = matchWorkflowByQuery(workflows.filter(isWanted), query);
    if (matched.ok) return matched;

    const elsewhere = matchWorkflowByQuery(
        workflows.filter((workflow) => !isWanted(workflow)),
        query
    );
    return elsewhere.ok
        ? { ok: false, reason: wrongKindReason(elsewhere.workflow, wanted) }
        : matched;
};
