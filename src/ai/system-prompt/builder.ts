/**
 * Assemble the per-request system prompt from three layers:
 *   1. preference (env/mounted file, operator-editable persona)
 *   2. dynamic environment (current time, current model id)
 *   3. built-in static sections (message format protocol, capabilities, notes)
 */
import { getModelCapabilities } from '../platform-factory.js';
import { getPreferencePrompt } from './preference.js';
import { buildFormatSection, CAPABILITIES_SECTION, NOTES_SECTION } from './sections.js';

const formatCurrentTime = (): string => {
    const timeZone = process.env.TZ || 'Asia/Shanghai';
    const now = new Date();
    // zh-CN yields "2026/08/31", "13:49" and "周一" respectively
    const date = new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
    const time = new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(now);
    const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'short' }).format(now);
    return `${date} ${time} ${weekday}（${timeZone}）`;
};

const buildEnvironmentSection = (model: string): string => `# 当前环境

- 当前时间：${formatCurrentTime()}
- 当前模型：${model}`;

export const buildSystemPrompt = (model: string): string => {
    const capabilities = getModelCapabilities(model);

    return [
        getPreferencePrompt(),
        buildEnvironmentSection(model),
        buildFormatSection({ includeOcrNote: !capabilities.supportsImageInput }),
        CAPABILITIES_SECTION,
        NOTES_SECTION,
    ]
        .filter((section) => section.length > 0)
        .join('\n\n');
};
