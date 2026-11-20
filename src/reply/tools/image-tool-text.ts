/**
 * Model-facing text of the image tools: candidate lists, what was attached,
 * what is left, and the next useful call. Pure functions so the offline suite
 * can pin the wording without a network or a Telegram client.
 */
import type { ReplyMediaState, SearchCandidate, SearchSet } from './reply-media-state.js';
import { unseenCandidates } from './reply-media-state.js';

/** Ids as the model reads them: `s1 s2 s3` */
const idList = (candidates: readonly SearchCandidate[]): string =>
    candidates.map((candidate) => candidate.id).join(' ');

const sizeOf = (candidate: SearchCandidate): string =>
    candidate.width !== undefined && candidate.height !== undefined
        ? `${candidate.width}x${candidate.height}`
        : '尺寸未知';

const formatOf = (candidate: SearchCandidate): string => {
    const format = candidate.format ?? '格式未知';
    if (candidate.sendKind === 'animated') return `${format} 动图`;
    if (candidate.sendKind === 'unsupported') return `${format}（发不了）`;
    return format;
};

/** `s1 · 634x539 · jpeg · bilibili.com · 标题` */
export const formatCandidateLine = (candidate: SearchCandidate, options: { withPage?: boolean } = {}): string => {
    const line = `${candidate.id} · ${sizeOf(candidate)} · ${formatOf(candidate)} · ${candidate.domain} · ${candidate.title}`;
    return options.withPage === true ? `${line}\n   ${candidate.sourcePage}` : line;
};

export interface SearchTextInput {
    readonly set: SearchSet;
    readonly attached: readonly SearchCandidate[];
    readonly failed: readonly SearchCandidate[];
    readonly view: 'thumbnails' | 'details';
    /** The model cannot see images: say so instead of promising pictures */
    readonly canSeeImages: boolean;
    /** A repeated query reused this set instead of hitting SearXNG */
    readonly reused: boolean;
}

/**
 * `第1张=s17、第2张=s18 …`: the pictures carry no id of their own (a text part
 * in Gemini's functionResponse is rejected), so the only binding is position.
 * Spelling it out keeps the model from sending a candidate by its title and
 * discovering later that it picked a different picture (live 1106627).
 */
const attachmentOrder = (attached: readonly SearchCandidate[]): string =>
    attached.map((candidate, index) => `第${index + 1}张=${candidate.id}`).join('、');

const attachLines = (input: SearchTextInput): string[] => {
    if (input.view === 'details') return [];

    const lines: string[] = [];
    if (input.attached.length > 0) {
        lines.push(
            `已附缩略图 ${input.attached.length} 张（图本身没编号，按下面的顺序对应）：${attachmentOrder(input.attached)}`
        );
    }
    if (input.failed.length > 0) {
        lines.push(`缩略图下载失败：${idList(input.failed)}（可以用 fetch_image 试原图）`);
    }
    return lines;
};

const nextStepLines = (input: SearchTextInput, unseen: readonly SearchCandidate[]): string[] => {
    const lines: string[] = [];
    const { set } = input;

    // Paging and fetching only exist for a model that can look at the pictures
    if (input.canSeeImages) {
        if (input.view === 'thumbnails' && unseen.length > 0) {
            lines.push(`- 想看剩下的 ${unseen.length} 张：search_images(search='${set.id}')`);
        }
        if (input.view === 'thumbnails') {
            lines.push(`- 只要文字清单：search_images(search='${set.id}', view='details')`);
        }
        if (unseen.length > 0) {
            const firstId = unseen[0]?.id ?? 's1';
            const taken = unseen.slice(0, 3).map((candidate) => `'${candidate.id}'`);
            const batch = taken.length > 1 ? `，多张用 fetch_image(search_ids=[${taken.join(',')}])` : '';
            lines.push(`- 单张看大图：fetch_image(search_id='${firstId}')${batch}`);
        }
    }
    lines.push(
        `- 确定要发：send_image(search_id='${set.candidates[0]?.id ?? 's1'}')；可以多次 send_image，一起作为本条回复的图片发出（相册）`
    );
    return lines;
};

/**
 * The tool result: every candidate with its metadata, which ones the model has
 * just been shown, which are left, and the calls that move forward.
 */
export const formatSearchResult = (input: SearchTextInput): string => {
    const { set } = input;
    const unseen = unseenCandidates(set);

    const header = [
        input.reused
            ? `这个查询已经搜过了，复用集合 ${set.id}（不会重复搜索）：「${set.query}」`
            : `图搜「${set.query}」→ ${set.id}，共 ${set.candidates.length} 条候选（SearXNG 相关度序）：`,
    ];

    const candidateLines = set.candidates.map((candidate) =>
        // Details exist to decide without pictures, so the page matters there
        formatCandidateLine(candidate, { withPage: input.view === 'details' })
    );

    return [
        ...header,
        ...candidateLines,
        ...attachLines(input),
        ...(input.canSeeImages
            ? [unseen.length === 0 ? '这批缩略图都看过了。' : `还没看：${idList(unseen)}`]
            : ['你看不到图：可按标题、尺寸和来源选择。']),
        ...nextStepLines(input, unseen),
    ].join('\n');
};

/** What fetch_image says after reading one image */
export const formatFetchResult = (input: {
    readonly image: {
        readonly id: string;
        readonly mimeType: string;
        readonly dataLength: number;
        readonly sourcePage: string;
        readonly width?: number;
        readonly height?: number;
    };
    readonly fromCandidateId?: string;
    /** Why this is not the original, when it is not */
    readonly note?: string;
}): string => {
    const { image } = input;
    const size =
        image.width !== undefined && image.height !== undefined ? `${image.width}x${image.height}，` : '';
    const origin = input.fromCandidateId ? `（来自 ${input.fromCandidateId}）` : '';
    const note = input.note ? `，${input.note}` : '';
    return [
        `已读取 ${image.id}${origin}：${size}${image.mimeType}，${Math.round(image.dataLength / 1024)}KB${note}。`,
        `来源页：${image.sourcePage}`,
        `可以直接作为 generate_image 的参考图（web_references），或 send_image(image_id='${image.id}') 发出（可多次 send_image 一起发）。`,
    ].join('\n');
};

/** What fetch_image says after an avatar arrives */
export const formatAvatarResult = (input: {
    readonly id: string;
    readonly label: string;
    readonly mimeType: string;
    readonly dataLength: number;
    readonly view: 'original' | 'thumbnail';
}): string => {
    const tier = input.view === 'thumbnail' ? '160 档缩略图' : '640 档';
    return [
        `已读取 ${input.id}：${input.label}（${tier} ${input.mimeType}，${Math.round(input.dataLength / 1024)}KB）。`,
        `可以直接作为 generate_image 的参考图（web_references），或 send_image(image_id='${input.id}') 发出（可多次 send_image 一起发）。`,
    ].join('\n');
};

/** A repeated avatar read: the bytes are already in the conversation */
export const formatAvatarReuse = (id: string, label: string): string =>
    `已经读过 ${id}（${label}），就在上面的对话里，不用重复读取。\n` +
    `可以直接 send_image(image_id='${id}') 发出，或作为 generate_image 的参考图。`;

/** One line: untrusted titles and errors must not forge another list item */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** What fetch_image says after reading several pictures in one call */
export const formatFetchBatchResult = (input: {
    readonly kind: 'image' | 'sticker';
    readonly lines: readonly { readonly id: string; readonly summary: string }[];
    /** How many of those lines carried new bytes; 0 = everything was already here */
    readonly freshCount: number;
    readonly failures: readonly string[];
    readonly skippedDuplicates: readonly string[];
    readonly sourcePages: readonly { readonly id: string; readonly page: string }[];
}): string => {
    const noun = input.kind === 'sticker' ? '张贴纸' : '张图';
    const output: string[] = [];
    if (input.lines.length === 0) {
        output.push(`这 ${input.failures.length} ${noun}都没读出来：`);
    } else {
        const ids = input.lines.map((line) => line.id).join('、');
        const header = input.freshCount === 0 ? '已在上下文里' : '已读取';
        output.push(`${header} ${input.lines.length} ${noun}（${ids}）：`);
        output.push(...input.lines.map((line) => `- ${line.id}：${oneLine(line.summary)}`));
        if (input.failures.length > 0) {
            output.push(`有 ${input.failures.length} ${noun}没读出来：`);
        }
    }
    if (input.failures.length > 0) {
        output.push(...input.failures.map((failure) => `- ${oneLine(failure)}`));
    }
    if (input.skippedDuplicates.length > 0) {
        const names = input.skippedDuplicates.map(oneLine).join('、');
        output.push(`重复的 ${input.skippedDuplicates.length} 项已跳过：${names}。`);
    }
    if (input.sourcePages.length > 0) {
        output.push('来源页：');
        output.push(...input.sourcePages.map((entry) => `- ${entry.id}：${oneLine(entry.page)}`));
    }
    const firstId = input.lines[0]?.id;
    if (firstId !== undefined) {
        output.push(
            input.kind === 'sticker'
                ? `想发就 send_sticker(sticker='${firstId}')。`
                : `可以直接作为 generate_image 的参考图（web_references），或 send_image(image_id='${firstId}') 发出（可多次 send_image 一起发）。`
        );
    }
    return output.join('\n');
};

/** What send_image says once the picture is on its way */
export const formatSendResult = (input: {
    /** 1-based position of this picture in the reply's list */
    readonly index: number;
    /** How many pictures one reply may carry */
    readonly limit: number;
    readonly candidateId?: string;
    readonly imageId?: string;
    /** A picture generate_image drew in this reply */
    readonly generatedId?: string;
    readonly contextNumber?: number;
    /** The chat receives an animation, not a still */
    readonly animated?: boolean;
    /** Why this is not the original, when it is not */
    readonly note?: string;
    readonly sourcePage?: string;
}): string => {
    const source = input.generatedId
        ? `本次生成的图 ${input.generatedId}`
        : input.candidateId
          ? `候选 ${input.candidateId}`
          : input.imageId
            ? `已读图 ${input.imageId}`
            : `#${input.contextNumber ?? '?'} 的图`;
    const note = input.note ? `（${input.note}）` : '';
    const kind = input.animated === true ? '动图' : '图片';
    const position =
        input.index > 1
            ? `这是本条回复的第 ${input.index}/${input.limit} 张，会和其它图片一起发出。`
            : `这是本条回复的第 1/${input.limit} 张；还可以继续 send_image 加图（多张会作为一条相册发出）。`;
    return [
        `已把${source}的${kind}发到聊天里${note}，会附在你这条回复后面。${position}`,
        ...(input.animated === true ? ['发出去的是会动的 GIF；下面给你看的是它的第一帧。'] : []),
        ...(input.sourcePage ? [`来源页：${input.sourcePage}`] : []),
    ].join('\n');
};

/** Error answers; every one names the next thing to try */
export const mediaToolErrors = {
    noMoreThumbnails: (setId: string) =>
        `${setId} 的候选都看过了。可以换一个 query、用 fetch_image 看原图，或直接 send_image。`,
    unknownSet: (setId: string, state: ReplyMediaState) => {
        const known = [...state.searches.values()].map((set) => `${set.id}（「${set.query}」）`).join('、');
        return `没有搜索集合 ${setId}。本次可用：${known || '还没有搜索过'}`;
    },
    unknownCandidate: (candidateId: string) =>
        `没有候选 ${candidateId}。候选编号形如 s1，先 search_images 或看工具结果里的编号。`,
    unknownFetched: (imageId: string) =>
        `没有图片 ${imageId}。编号可以是 generate_image 本次生成的 g1，或 fetch_image 读过的 img1。`,
    noImageSource: '要发哪张图？传 search_id、image_id、message（上下文编号）或 url 之一。',
    downloadFailed: (reason: string) => `图片没取到：${reason}`,
    notAnImage: '这张不是 PNG/JPEG/WebP/GIF 图片，发不了。换一张候选试试。',
    tooLarge: (megabytes: number) => `图片超过 ${megabytes}MB，发不了。换一张候选试试。`,
    imageLimitReached: (limit: number) =>
        `这条回复已经有 ${limit} 张图片了（每条回复最多 ${limit} 张），这张发不了；可以用 send_image 之外的其它回答继续。`,
    imageTotalTooLarge: (megabytes: number) =>
        `这条回复的图片总大小超过 ${megabytes}MB 了，这张发不了；可以先少发几张。`,
};
