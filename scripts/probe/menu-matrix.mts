/**
 * The probe's menu matrix snapshot: the chat-menu models a default probe run covers,
 * in menu order, with the reasoning facts from the capability seed.
 *
 * The probe CLI must not import `src/` (AGENTS: a script that imports src imports the
 * offline harness first, whose `DB_PATH` rewrite would break the probe test-instance
 * gate), so this file is a snapshot. It is generated, never edited by hand:
 *
 *     npx tsx scripts/probe/refresh-menu-matrix.mts
 *
 * `scripts/offline/probe-matrix-sync.mts` fails when this snapshot and the runtime
 * menu disagree, so a menu or seed change cannot silently ship a stale matrix.
 *
 * Generated on 2026-11-13 from the runtime menu config (modelConfigs) and
 * the capability seed (reasoning). Prices stay in effort-plan.
 */
import type { EffortValue, ProbePlatform } from './effort-types.mts';

/** One chat-menu model the default probe matrix covers */
export interface MenuMatrixEntry {
    readonly model: string;
    readonly platform: ProbePlatform;
    readonly vendorEfforts: readonly EffortValue[];
    readonly vendorDefaultEffort: EffortValue | null;
    readonly vendorToggle: boolean;
    readonly vendorDefaultEnabled: boolean | null;
}

/** The chat menu in order; regenerate with scripts/probe/refresh-menu-matrix.mts */
export const MENU_MATRIX: readonly MenuMatrixEntry[] = [
    {
        model: 'gpt-6-luna',
        platform: 'openai',
        vendorEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        vendorDefaultEffort: 'medium',
        vendorToggle: false,
        vendorDefaultEnabled: null,
    },
    {
        model: 'gpt-6-sol',
        platform: 'openai',
        vendorEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        vendorDefaultEffort: 'medium',
        vendorToggle: false,
        vendorDefaultEnabled: null,
    },
    {
        model: 'gpt-6-astra',
        platform: 'openai',
        vendorEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        vendorDefaultEffort: 'medium',
        vendorToggle: false,
        vendorDefaultEnabled: null,
    },
    {
        model: 'claude-sonnet-5-5',
        platform: 'anthropic',
        vendorEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        vendorDefaultEffort: 'high',
        vendorToggle: false,
        vendorDefaultEnabled: null,
    },
    {
        model: 'claude-opus-5-5',
        platform: 'anthropic',
        vendorEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        vendorDefaultEffort: 'high',
        vendorToggle: false,
        vendorDefaultEnabled: null,
    },
    {
        model: 'gemini-4-hydrogen',
        platform: 'gemini',
        vendorEfforts: ['low', 'medium', 'high', 'xhigh'],
        vendorDefaultEffort: 'high',
        vendorToggle: false,
        vendorDefaultEnabled: null,
    },
    {
        model: 'gemini-4-argon',
        platform: 'gemini',
        vendorEfforts: ['low', 'medium', 'high'],
        vendorDefaultEffort: 'medium',
        vendorToggle: false,
        vendorDefaultEnabled: null,
    },
    {
        model: 'gemini-4-carbon',
        platform: 'gemini',
        vendorEfforts: ['low', 'medium', 'high'],
        vendorDefaultEffort: 'medium',
        vendorToggle: false,
        vendorDefaultEnabled: null,
    },
    {
        model: 'deepseek-flash',
        platform: 'deepseek',
        vendorEfforts: ['low', 'high', 'max'],
        vendorDefaultEffort: 'high',
        vendorToggle: true,
        vendorDefaultEnabled: true,
    },
    {
        model: 'grok-4.7',
        platform: 'grok',
        vendorEfforts: ['low', 'medium', 'high', 'xhigh'],
        vendorDefaultEffort: 'high',
        vendorToggle: false,
        vendorDefaultEnabled: null,
    },
    {
        model: 'grok-4.20-multi-agent-0309',
        platform: 'grok',
        vendorEfforts: ['low', 'medium', 'high', 'xhigh'],
        vendorDefaultEffort: 'high',
        vendorToggle: false,
        vendorDefaultEnabled: null,
    },
    {
        model: 'mimo-v2.6-flash',
        platform: 'mimo',
        vendorEfforts: [],
        vendorDefaultEffort: null,
        vendorToggle: true,
        vendorDefaultEnabled: true,
    },
    {
        model: 'mimo-v2.6-pro',
        platform: 'mimo',
        vendorEfforts: [],
        vendorDefaultEffort: null,
        vendorToggle: true,
        vendorDefaultEnabled: true,
    },
];
