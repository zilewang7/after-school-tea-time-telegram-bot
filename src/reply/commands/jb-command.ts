/**
 * `/jb` — start, stop or list a jailbreak tree (design 2026-1128-0045).
 *
 * Syntax:
 *   /jb [policy:<name>] [model:<id>] <prompt…>
 *   /jb off
 *   /jb list
 *
 * `policy:` picks a `prompt_templates` row by name (its content is the policy
 * text); without it the first enabled template named `policy:*` is used.
 * `model:` overrides the model for this tree only.
 *
 * Parsing lives here and stays side-effect free; the reply handler wires it to
 * the database and to `handleReply` (importing the reply path from this module
 * would close a cycle).
 */
import { ensurePromptTemplatesCacheLoaded, listPromptTemplates, type PromptTemplate } from '../../services/prompt-templates-cache.js';

export type JbCommand =
    | { readonly kind: 'start'; readonly prompt: string; readonly policyName: string | null; readonly model: string | null }
    | { readonly kind: 'off' }
    | { readonly kind: 'list' }
    | { readonly kind: 'help' };

const JB_PREFIX = /^\/jb(?:@[A-Za-z0-9_]+)?(?=\s|$)/;

/** True for `/jb`, `/jb …` and `/jb@bot …` */
export const isJbCommandText = (text: string): boolean => JB_PREFIX.test(text.trim());

const POLICY_TOKEN = /^policy[:=](.+)$/i;
const MODEL_TOKEN = /^model[:=](.+)$/i;

export const parseJbCommand = (text: string): JbCommand | null => {
    const trimmed = text.trim();
    if (!JB_PREFIX.test(trimmed)) return null;
    const rest = trimmed.replace(JB_PREFIX, '').trim();
    if (rest === '') return { kind: 'help' };
    const words = rest.split(/\s+/);
    const head = words[0]?.toLowerCase() ?? '';
    if (head === 'off' && words.length === 1) return { kind: 'off' };
    if (head === 'list' && words.length === 1) return { kind: 'list' };

    let policyName: string | null = null;
    let model: string | null = null;
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        if (word === undefined) break;
        const policy = POLICY_TOKEN.exec(word);
        if (policy !== null) {
            const value = policy[1];
            if (value === undefined) break;
            policyName = value;
            index += 1;
            continue;
        }
        const modelMatch = MODEL_TOKEN.exec(word);
        if (modelMatch !== null) {
            const value = modelMatch[1];
            if (value === undefined) break;
            model = value;
            index += 1;
            continue;
        }
        break;
    }
    const prompt = words.slice(index).join(' ').trim();
    if (prompt === '') return { kind: 'help' };
    return { kind: 'start', prompt, policyName, model };
};

/** The policy template a command names, or the default `policy:*` one */
export const resolveJbPolicyTemplate = async (
    policyName: string | null,
    actorId: number
): Promise<PromptTemplate | null> => {
    await ensurePromptTemplatesCacheLoaded();
    const templates = listPromptTemplates().filter((template) => template.enabled);
    if (policyName !== null) {
        const named = templates.filter((template) => template.name === policyName);
        return (
            named.find((template) => template.createdBy === actorId) ??
            named.find((template) => template.visibility === 'global') ??
            null
        );
    }
    return templates.find((template) => template.name.startsWith('policy:')) ?? null;
};
