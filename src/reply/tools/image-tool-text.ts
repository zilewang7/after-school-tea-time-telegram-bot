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
            lines.push(`- 单张看大图：fetch_image(search_id='${unseen[0]?.id ?? 's1'}')`);
        }
    }
    lines.push(`- 确定要发：send_image(search_id='${set.candidates[0]?.id ?? 's1'}')`);
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
        `可以直接作为 generate_image 的参考图（web_references），或 send_image(image_id='${image.id}') 发出。`,
    ].join('\n');
};

/** What send_image says once the picture is on its way */
export const formatSendResult = (input: {
    readonly candidateId?: string;
    readonly imageId?: string;
    readonly contextNumber?: number;
    /** The chat receives an animation, not a still */
    readonly animated?: boolean;
    /** Why this is not the original, when it is not */
    readonly note?: string;
    readonly sourcePage?: string;
}): string => {
    const source = input.candidateId
        ? `候选 ${input.candidateId}`
        : input.imageId
          ? `已读图 ${input.imageId}`
          : `#${input.contextNumber ?? '?'} 的图`;
    const note = input.note ? `（${input.note}）` : '';
    const kind = input.animated === true ? '动图' : '图片';
    return [
        `已把${source}的${kind}发到聊天里${note}，会附在你这条回复后面。`,
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
    unknownFetched: (imageId: string) => `没有读过的图 ${imageId}。先用 fetch_image 读取，或改用 search_id。`,
    noImageSource: '要发哪张图？传 search_id、image_id、message（上下文编号）或 url 之一。',
    downloadFailed: (reason: string) => `图片没取到：${reason}`,
    notAnImage: '这张不是 PNG/JPEG/WebP/GIF 图片，发不了。换一张候选试试。',
    tooLarge: (megabytes: number) => `图片超过 ${megabytes}MB，发不了。换一张候选试试。`,
    alreadyHasImage: '这条回复已经有一张图或贴纸了，每条回复只能发一个视觉附件。',
};
