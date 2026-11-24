/**
 * Zero-dependency YAML frontmatter parser for repository SKILL.md files.
 *
 * Supports top-level single-line strings, folded (`>`) and literal (`|`)
 * block scalars, and a two-level `metadata:` string-to-string map. Rejects
 * malformed syntax, C0 control characters and non-string metadata values.
 */

// oxlint-disable-next-line no-control-regex -- matching C0 control characters is the point
export const C0_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const FRONTMATTER_FENCE = /^---[ \t]*$/;
const KEY_VALUE_LINE = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/;
const BLOCK_SCALAR_HEADER = /^([>|])([+-])?$/;
const UNQUOTED_NON_STRING = /^(?:true|false|null|~|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/i;

export interface ParsedSkillFrontmatter {
    readonly fields: Readonly<Record<string, string>>;
    readonly metadata: Readonly<Record<string, string>>;
    readonly body: string;
}

export type FrontmatterParseResult =
    | { readonly ok: true; readonly value: ParsedSkillFrontmatter }
    | { readonly ok: false; readonly error: string };

const fail = (error: string): { readonly ok: false; readonly error: string } => ({ ok: false, error });

const indentOf = (line: string): number => {
    let count = 0;
    while (count < line.length && line[count] === ' ') count += 1;
    return count;
};

/** Strip an unquoted trailing `# comment` preceded by whitespace */
const stripInlineComment = (value: string): string => {
    let inSingle = false;
    let inDouble = false;
    for (let index = 0; index < value.length; index += 1) {
        const ch = value[index];
        if (ch === "'" && !inDouble) {
            if (inSingle && value[index + 1] === "'") {
                index += 1;
                continue;
            }
            inSingle = !inSingle;
            continue;
        }
        if (ch === '"' && !inSingle) {
            if (inDouble && value[index - 1] === '\\') continue;
            inDouble = !inDouble;
            continue;
        }
        if (!inSingle && !inDouble && ch === '#' && index > 0 && (value[index - 1] === ' ' || value[index - 1] === '\t')) {
            return value.slice(0, index).trimEnd();
        }
    }
    return value.trimEnd();
};

const unescapeDoubleQuoted = (raw: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } => {
    let out = '';
    for (let index = 0; index < raw.length; index += 1) {
        const ch = raw[index];
        if (ch !== '\\') {
            out += ch;
            continue;
        }
        const next = raw[index + 1];
        if (next === undefined) return fail('双引号字符串存在未闭合的转义符');
        index += 1;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else if (next === '"' || next === '\\' || next === '/') out += next;
        else out += `\\${next}`;
    }
    return { ok: true, value: out };
};

const parseScalarValue = (
    rawInput: string,
    options: { readonly allowNonStringLiteral: boolean }
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } => {
    const trimmed = stripInlineComment(rawInput.trimStart());
    if (trimmed === '') return { ok: true, value: '' };

    if (trimmed.startsWith('"')) {
        if (trimmed.length < 2 || !trimmed.endsWith('"')) {
            return fail('双引号字符串未闭合');
        }
        // Ensure the closing quote is not escaped
        let backslashes = 0;
        for (let index = trimmed.length - 2; index >= 1 && trimmed[index] === '\\'; index -= 1) {
            backslashes += 1;
        }
        if (backslashes % 2 === 1) return fail('双引号字符串未闭合');
        return unescapeDoubleQuoted(trimmed.slice(1, -1));
    }

    if (trimmed.startsWith("'")) {
        if (trimmed.length < 2 || !trimmed.endsWith("'")) {
            return fail('单引号字符串未闭合');
        }
        return { ok: true, value: trimmed.slice(1, -1).replace(/''/g, "'") };
    }

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        return fail('frontmatter 标量字段不支持内联数组或对象');
    }

    if (!options.allowNonStringLiteral && UNQUOTED_NON_STRING.test(trimmed)) {
        return fail(`metadata 值 "${trimmed}" 必须是字符串（请加引号）`);
    }

    return { ok: true, value: trimmed };
};

interface BlockScalarResult {
    readonly ok: true;
    readonly value: string;
    readonly nextIndex: number;
}

const parseBlockScalar = (
    lines: readonly string[],
    startIndex: number,
    minIndent: number,
    style: '>' | '|',
    chomp: '+' | '-' | ''
): BlockScalarResult | { readonly ok: false; readonly error: string } => {
    const collected: string[] = [];
    let blockIndent: number | null = null;
    let index = startIndex;

    while (index < lines.length) {
        const line = lines[index] ?? '';
        if (line.trim() === '') {
            collected.push('');
            index += 1;
            continue;
        }
        if (line.startsWith('\t')) return { ok: false, error: 'frontmatter 缩进不能使用制表符 Tab' };
        const indent = indentOf(line);
        if (blockIndent === null) {
            if (indent < minIndent) break;
            blockIndent = indent;
        } else if (indent < blockIndent) {
            break;
        }
        collected.push(line.slice(blockIndent));
        index += 1;
    }

    let trailingBlanks = 0;
    while (trailingBlanks < collected.length && collected[collected.length - 1 - trailingBlanks] === '') {
        trailingBlanks += 1;
    }
    const contentLines = collected.slice(0, collected.length - trailingBlanks);
    if (contentLines.length === 0) {
        return { ok: true, value: '', nextIndex: index };
    }

    let text: string;
    if (style === '|') {
        text = contentLines.join('\n');
    } else {
        const paragraphs: string[] = [];
        let current: string[] = [];
        for (const item of contentLines) {
            if (item === '') {
                if (current.length > 0) {
                    paragraphs.push(current.join(' '));
                    current = [];
                } else {
                    paragraphs.push('');
                }
            } else {
                current.push(item.trim());
            }
        }
        if (current.length > 0) paragraphs.push(current.join(' '));
        text = paragraphs.join('\n');
    }

    if (chomp === '+') {
        text += '\n'.repeat(trailingBlanks + 1);
    } else if (chomp === '') {
        // Clip keeps semantics compact for single-field display when trimmed by caller
        text = text.trimEnd();
    }

    return { ok: true, value: text, nextIndex: index };
};

/** Parse YAML frontmatter + Markdown body from raw SKILL.md text */
export const parseSkillFrontmatter = (rawContent: string): FrontmatterParseResult => {
    const normalized = rawContent.replace(/\r\n/g, '\n');
    if (C0_CONTROL_CHARS.test(normalized)) {
        return fail('文件包含不允许的 C0 控制字符');
    }

    const lines = normalized.split('\n');
    if (!FRONTMATTER_FENCE.test(lines[0] ?? '')) {
        return fail('SKILL.md 必须以 --- frontmatter 开头');
    }

    let closingIndex = -1;
    for (let index = 1; index < lines.length; index += 1) {
        if (FRONTMATTER_FENCE.test(lines[index] ?? '')) {
            closingIndex = index;
            break;
        }
    }
    if (closingIndex === -1) {
        return fail('SKILL.md frontmatter 缺少闭合的 ---');
    }

    const fmLines = lines.slice(1, closingIndex);
    const fields: Record<string, string> = {};
    const metadata: Record<string, string> = {};

    let index = 0;
    while (index < fmLines.length) {
        const line = fmLines[index] ?? '';
        if (line.trim() === '' || /^\s*#/.test(line)) {
            index += 1;
            continue;
        }
        if (line.startsWith('\t')) return fail('frontmatter 缩进不能使用制表符 Tab');
        if (indentOf(line) > 0) {
            return fail(`frontmatter 出现意外缩进：${line.trim()}`);
        }

        const match = KEY_VALUE_LINE.exec(line);
        if (match === null) {
            return fail(`frontmatter 行格式无效：${line}`);
        }
        const key = match[1] ?? '';
        const rawRest = match[2] ?? '';

        if (key === 'metadata') {
            if (Object.keys(metadata).length > 0 || key in fields) {
                return fail('frontmatter 存在重复的 metadata 键');
            }
            const rest = stripInlineComment(rawRest.trimStart());
            if (rest !== '' && rest !== '{}') {
                return fail('metadata 必须是键值对映射');
            }
            fields[key] = '';
            index += 1;
            let metaIndent: number | null = null;
            while (index < fmLines.length) {
                const subLine = fmLines[index] ?? '';
                if (subLine.trim() === '' || /^\s*#/.test(subLine)) {
                    index += 1;
                    continue;
                }
                if (subLine.startsWith('\t')) return fail('metadata 缩进不能使用制表符 Tab');
                const indent = indentOf(subLine);
                if (indent === 0) break;
                if (metaIndent === null) {
                    metaIndent = indent;
                } else if (indent !== metaIndent) {
                    return fail(`metadata 缩进不一致或存在嵌套结构：${subLine.trim()}`);
                }
                const trimmedSub = subLine.slice(indent);
                if (trimmedSub.startsWith('-')) {
                    return fail('metadata 必须是 string->string 映射，不支持数组');
                }
                const subMatch = KEY_VALUE_LINE.exec(trimmedSub);
                if (subMatch === null) {
                    return fail(`metadata 行格式无效：${trimmedSub}`);
                }
                const subKey = subMatch[1] ?? '';
                const subRest = subMatch[2] ?? '';
                if (subKey in metadata) {
                    return fail(`metadata 存在重复键：${subKey}`);
                }

                const blockHeader = BLOCK_SCALAR_HEADER.exec(stripInlineComment(subRest.trimStart()));
                if (blockHeader !== null) {
                    const style = blockHeader[1] === '|' ? '|' : '>';
                    const chomp =
                        blockHeader[2] === '+' ? '+' : blockHeader[2] === '-' ? '-' : '';
                    const block = parseBlockScalar(fmLines, index + 1, indent + 1, style, chomp);
                    if (!block.ok) return fail(block.error);
                    metadata[subKey] = block.value;
                    index = block.nextIndex;
                    continue;
                }

                const parsedSub = parseScalarValue(subRest, { allowNonStringLiteral: false });
                if (!parsedSub.ok) return fail(parsedSub.error);
                if (parsedSub.value === '' && subRest.trim() === '') {
                    // Empty value could be followed by a nested block -> reject nested map/list
                    const nextNonBlank = fmLines.slice(index + 1).find((candidate) => candidate.trim() !== '' && !/^\s*#/.test(candidate));
                    if (nextNonBlank !== undefined && indentOf(nextNonBlank) > indent) {
                        return fail(`metadata.${subKey} 不支持嵌套对象或数组`);
                    }
                }
                metadata[subKey] = parsedSub.value;
                index += 1;
            }
            continue;
        }

        if (key in fields) {
            return fail(`frontmatter 存在重复键：${key}`);
        }

        const blockHeader = BLOCK_SCALAR_HEADER.exec(stripInlineComment(rawRest.trimStart()));
        if (blockHeader !== null) {
            const style = blockHeader[1] === '|' ? '|' : '>';
            const chomp = blockHeader[2] === '+' ? '+' : blockHeader[2] === '-' ? '-' : '';
            const block = parseBlockScalar(fmLines, index + 1, 1, style, chomp);
            if (!block.ok) return fail(block.error);
            fields[key] = block.value;
            index = block.nextIndex;
            continue;
        }

        const parsedValue = parseScalarValue(rawRest, { allowNonStringLiteral: true });
        if (!parsedValue.ok) return fail(parsedValue.error);
        if (parsedValue.value === '' && rawRest.trim() === '') {
            const nextNonBlank = fmLines.slice(index + 1).find((candidate) => candidate.trim() !== '' && !/^\s*#/.test(candidate));
            if (nextNonBlank !== undefined && indentOf(nextNonBlank) > 0) {
                return fail(`frontmatter 字段 ${key} 不支持嵌套结构`);
            }
        }
        fields[key] = parsedValue.value;
        index += 1;
    }

    const rawBody = lines.slice(closingIndex + 1).join('\n');
    const body = rawBody.replace(/^\n+/, '').replace(/\n+$/, '');
    return {
        ok: true,
        value: { fields, metadata, body },
    };
};
