import type { ClipboardConversion } from '../../../tools/types';

const ENTITY_LABELS: Readonly<Record<string, string>> = {
    bold: '粗体',
    italic: '斜体',
    underline: '下划线',
    strikethrough: '删除线',
    spoiler: '剧透',
    code: '行内代码',
    pre: '代码块',
    blockquote: '引用',
    expandable_blockquote: '折叠引用',
    text_link: '链接',
};

const SOURCE_LABELS: Readonly<Record<ClipboardConversion['source'], string>> = {
    'webk-json': 'WebK JSON（精确实体）',
    html: 'HTML（按标签解析）',
};

export interface ParsedSummaryView {
    sourceLabel: string;
    characterCount: number;
    entityChips: readonly string[];
    ignoredTags: readonly string[];
}

/** Turn a reverse conversion into the short "what was parsed" summary */
export const parsedSummaryOf = (conversion: ClipboardConversion): ParsedSummaryView => {
    const counts = new Map<string, number>();
    for (const entity of conversion.entities) {
        counts.set(entity.type, (counts.get(entity.type) ?? 0) + 1);
    }
    const entityChips = [...counts.entries()].map(([type, count]) => `${ENTITY_LABELS[type] ?? type} ×${count}`);
    return {
        sourceLabel: SOURCE_LABELS[conversion.source],
        characterCount: conversion.text.length,
        entityChips,
        ignoredTags: conversion.ignoredTags,
    };
};

interface ParsedSummaryProps {
    summary: ParsedSummaryView;
}

/** What the parser recognised, and which tags it had to drop */
export const ParsedSummary = ({ summary }: ParsedSummaryProps) => (
    <div className="field-group">
        <p className="hint">
            解析到的格式：{summary.sourceLabel} · {summary.characterCount} 字符
        </p>
        {summary.entityChips.length > 0 && (
            <div className="tools-chip-row">
                {summary.entityChips.map((chip) => (
                    <span className="tools-chip" key={chip}>
                        {chip}
                    </span>
                ))}
            </div>
        )}
        {summary.ignoredTags.length > 0 && (
            <p className="hint tools-ignored">已忽略的标签：{summary.ignoredTags.join('、')}</p>
        )}
    </div>
);
