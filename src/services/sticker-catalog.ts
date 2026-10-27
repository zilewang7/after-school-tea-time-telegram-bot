/**
 * The fixed ColorfulHachimi sticker pack, in the pack's own order.
 *
 * This table is the only place the pack is described. `packIndex` is what the
 * model and the user mean by "第 N 张": the order Telegram shows, not the
 * original file numbering (which is kept as `sourceFileNumber` for tracing
 * only and never reaches a prompt).
 *
 * `label` is the actual picture. Several original filenames name things that
 * are not in the drawing (a crown, a cat hat, angel wings); those names are
 * deliberately absent from this table so the model cannot pick a sticker for
 * a hat it will not see.
 *
 * `fileUniqueId` is how the runtime finds the current file_id: it survives a
 * bot token change and catches an edited pack, where the position may mean a
 * different picture. Regenerate this table after the author edits the pack.
 *
 * The pack holds 72 unique pictures today. 03 used to repeat 72; the author
 * replaced it on 2026-10-27, so it has no original file number (`0`).
 */
export interface StickerCatalogEntry {
    /** 1-based position in the pack, 1..72 */
    readonly packIndex: number;
    /** What the picture actually shows; the only name the model sees */
    readonly label: string;
    /** Original file number, for tracing only; never shown to the model. 0 = added by the author later */
    readonly sourceFileNumber: number;
    readonly emoji: string;
    /** Stable across bots and pack edits; resolves to file_id at runtime */
    readonly fileUniqueId: string;
    /** This picture repeats another pack index (none in the pack today) */
    readonly duplicateOf?: number;
}

export const STICKER_CATALOG: readonly StickerCatalogEntry[] = [
    { packIndex: 1, label: '眯眼猫嘴', sourceFileNumber: 29, emoji: '😊', fileUniqueId: 'AgAD7R8AAube8FY' },
    { packIndex: 2, label: '趴着等待', sourceFileNumber: 59, emoji: '⏳', fileUniqueId: 'AgADgCAAAkdC8VY' },
    { packIndex: 3, label: '蜷手困惑', sourceFileNumber: 0, emoji: '❓', fileUniqueId: 'AgADEyMAAv5cCVc' },
    { packIndex: 4, label: '起床揉眼', sourceFileNumber: 30, emoji: '🌅', fileUniqueId: 'AgADbigAAjau8VY' },
    { packIndex: 5, label: '趴白枕', sourceFileNumber: 47, emoji: '🍊', fileUniqueId: 'AgADXR8AAjbH8VY' },
    { packIndex: 6, label: '吃汉堡', sourceFileNumber: 28, emoji: '🍔', fileUniqueId: 'AgADqSIAAro_8VY' },
    { packIndex: 7, label: '吃冰棒', sourceFileNumber: 23, emoji: '🍦', fileUniqueId: 'AgADxSEAArbe8VY' },
    { packIndex: 8, label: '吃棒棒糖', sourceFileNumber: 69, emoji: '🍭', fileUniqueId: 'AgADSycAAnXa8VY' },
    { packIndex: 9, label: '大口吃蛋糕', sourceFileNumber: 39, emoji: '🍰', fileUniqueId: 'AgADbR0AAraL-FY' },
    { packIndex: 10, label: '抱着草莓蛋糕', sourceFileNumber: 22, emoji: '🎂', fileUniqueId: 'AgAD0iQAAh-K8FY' },
    { packIndex: 11, label: '圣诞装扮', sourceFileNumber: 48, emoji: '🎅', fileUniqueId: 'AgADWR8AArX08VY' },
    { packIndex: 12, label: '穿白色猫咪兜帽', sourceFileNumber: 68, emoji: '🐱', fileUniqueId: 'AgADyiIAAi7N8VY' },
    { packIndex: 13, label: '猫爪喵喵', sourceFileNumber: 17, emoji: '🐾', fileUniqueId: 'AgADHSEAAiUw8FY' },
    { packIndex: 14, label: '躲在墙后偷看', sourceFileNumber: 5, emoji: '👀', fileUniqueId: 'AgADXyIAAmoP8VY' },
    { packIndex: 15, label: '挥手告别', sourceFileNumber: 26, emoji: '👋', fileUniqueId: 'AgADtCMAAnbj8VY' },
    { packIndex: 16, label: '举爪招呼', sourceFileNumber: 35, emoji: '👌', fileUniqueId: 'AgADciIAAuuS8FY' },
    { packIndex: 17, label: '端坐露齿笑', sourceFileNumber: 64, emoji: '👑', fileUniqueId: 'AgADXiEAAnEU-VY' },
    { packIndex: 18, label: '叼奶嘴', sourceFileNumber: 65, emoji: '👶', fileUniqueId: 'AgADyiMAAhVh8VY' },
    { packIndex: 19, label: '抱爱心', sourceFileNumber: 62, emoji: '💖', fileUniqueId: 'AgADax0AAgU7-VY' },
    { packIndex: 20, label: '熟睡', sourceFileNumber: 2, emoji: '💤', fileUniqueId: 'AgADUycAArAg8VY' },
    { packIndex: 21, label: '张嘴呐喊', sourceFileNumber: 51, emoji: '📣', fileUniqueId: 'AgADICEAAgJ_8VY' },
    { packIndex: 22, label: '尴尬流汗', sourceFileNumber: 56, emoji: '😅', fileUniqueId: 'AgADuyYAAr6S8FY' },
    { packIndex: 23, label: '趴着托腮', sourceFileNumber: 21, emoji: '😇', fileUniqueId: 'AgADqiAAAn5d-FY' },
    { packIndex: 24, label: '调皮吐舌', sourceFileNumber: 72, emoji: '😈', fileUniqueId: 'AgADLSIAAr0r-FY' },
    { packIndex: 25, label: '想吃甜点', sourceFileNumber: 13, emoji: '😋', fileUniqueId: 'AgADEyUAAt-o8FY' },
    { packIndex: 26, label: '戴墨镜耍酷', sourceFileNumber: 42, emoji: '😎', fileUniqueId: 'AgAD2CIAAksF8VY' },
    { packIndex: 27, label: '戳脸得意', sourceFileNumber: 8, emoji: '😏', fileUniqueId: 'AgADuR0AAt0u8FY' },
    { packIndex: 28, label: '无语省略号', sourceFileNumber: 52, emoji: '😑', fileUniqueId: 'AgADZyoAAvGv8FY' },
    { packIndex: 29, label: '歪头嫌弃', sourceFileNumber: 20, emoji: '😒', fileUniqueId: 'AgADHx8AApZb8FY' },
    { packIndex: 30, label: '刘海遮眼低落', sourceFileNumber: 61, emoji: '😞', fileUniqueId: 'AgADWCcAAvnf8FY' },
    { packIndex: 31, label: '脸色阴沉', sourceFileNumber: 45, emoji: '😠', fileUniqueId: 'AgADfyEAAlFp8FY' },
    { packIndex: 32, label: '鼓脸生气', sourceFileNumber: 12, emoji: '😤', fileUniqueId: 'AgADBCEAAo82-FY' },
    { packIndex: 33, label: '吓到吐舌', sourceFileNumber: 54, emoji: '😨', fileUniqueId: 'AgADkiUAAs5b8VY' },
    { packIndex: 34, label: '刚睡醒', sourceFileNumber: 1, emoji: '😪', fileUniqueId: 'AgADTSAAAh1F-VY' },
    { packIndex: 35, label: '坐地大哭', sourceFileNumber: 11, emoji: '😭', fileUniqueId: 'AgADIiMAArdT8FY' },
    { packIndex: 36, label: '张嘴惊讶', sourceFileNumber: 6, emoji: '😮', fileUniqueId: 'AgAD9iMAAttp-VY' },
    { packIndex: 37, label: '慌张手足无措', sourceFileNumber: 53, emoji: '😰', fileUniqueId: 'AgADNC0AAs0W8FY' },
    { packIndex: 38, label: '夸张震惊', sourceFileNumber: 27, emoji: '😱', fileUniqueId: 'AgADiiIAAher8VY' },
    { packIndex: 39, label: '打哈欠', sourceFileNumber: 31, emoji: '😴', fileUniqueId: 'AgADcyEAAjwi8VY' },
    { packIndex: 40, label: '戴漩涡眼镜', sourceFileNumber: 60, emoji: '😵‍💫', fileUniqueId: 'AgAD5CQAAitc8FY' },
    { packIndex: 41, label: '趴枕吐舌', sourceFileNumber: 38, emoji: '😶', fileUniqueId: 'AgADFCYAAld_8FY' },
    { packIndex: 42, label: '笑眼跪坐', sourceFileNumber: 66, emoji: '😺', fileUniqueId: 'AgADbCEAAp7t8FY' },
    { packIndex: 43, label: '抱着猫咪满足', sourceFileNumber: 41, emoji: '😻', fileUniqueId: 'AgAD-SEAAs1t8VY' },
    { packIndex: 44, label: '趴着撒娇', sourceFileNumber: 10, emoji: '😽', fileUniqueId: 'AgAD6B8AAi7m-VY' },
    { packIndex: 45, label: '倒挂探头', sourceFileNumber: 34, emoji: '🙃', fileUniqueId: 'AgADFSgAAsQL8VY' },
    { packIndex: 46, label: '抱臂不满', sourceFileNumber: 37, emoji: '🙅', fileUniqueId: 'AgADlh8AAk-58VY' },
    { packIndex: 47, label: '握拳加油', sourceFileNumber: 9, emoji: '🙆', fileUniqueId: 'AgADsSMAAi_G8FY' },
    { packIndex: 48, label: '低头委屈', sourceFileNumber: 14, emoji: '🙇', fileUniqueId: 'AgADZzQAAtwR8VY' },
    { packIndex: 49, label: '泡泡浴', sourceFileNumber: 43, emoji: '🛁', fileUniqueId: 'AgAD5iAAAul48FY' },
    { packIndex: 50, label: '拉被偷看', sourceFileNumber: 4, emoji: '🛌', fileUniqueId: 'AgAD2CIAAiCE8VY' },
    { packIndex: 51, label: '钻进被窝睡觉', sourceFileNumber: 32, emoji: '🛏️', fileUniqueId: 'AgADkyEAAiIM8VY' },
    { packIndex: 52, label: '抱膝发呆', sourceFileNumber: 71, emoji: '🤔', fileUniqueId: 'AgADvx4AAmGy8FY' },
    { packIndex: 53, label: '举手求抱抱', sourceFileNumber: 15, emoji: '🤗', fileUniqueId: 'AgAD9i0AAoPr8VY' },
    { packIndex: 54, label: '问号疑惑', sourceFileNumber: 55, emoji: '🤨', fileUniqueId: 'AgADtTIAAnl68VY' },
    { packIndex: 55, label: '星星眼跪坐笑', sourceFileNumber: 7, emoji: '🤩', fileUniqueId: 'AgADEh8AApal-VY' },
    { packIndex: 56, label: '掩嘴偷笑', sourceFileNumber: 57, emoji: '🤭', fileUniqueId: 'AgAD9CYAAs448VY' },
    { packIndex: 57, label: '戳脸吐舌', sourceFileNumber: 49, emoji: '🥰', fileUniqueId: 'AgADZCEAAmvK8VY' },
    { packIndex: 58, label: '困倦半睁眼', sourceFileNumber: 3, emoji: '🥱', fileUniqueId: 'AgADuCUAAnB48VY' },
    { packIndex: 59, label: '热得吐舌', sourceFileNumber: 44, emoji: '🥵', fileUniqueId: 'AgAD0iMAAvjC8FY' },
    { packIndex: 60, label: '裹着猫咪毯子', sourceFileNumber: 46, emoji: '🥶', fileUniqueId: 'AgADkSAAAo6i-VY' },
    { packIndex: 61, label: '泪眼汪汪', sourceFileNumber: 40, emoji: '🥹', fileUniqueId: 'AgAD4iIAAgzA8VY' },
    { packIndex: 62, label: '含泪委屈', sourceFileNumber: 50, emoji: '🥺', fileUniqueId: 'AgADnCkAAmiH-VY' },
    { packIndex: 63, label: '捧脸欢笑', sourceFileNumber: 70, emoji: '🦀', fileUniqueId: 'AgADZCMAAo3H8VY' },
    { packIndex: 64, label: '抿嘴疑惑', sourceFileNumber: 36, emoji: '🧐', fileUniqueId: 'AgADlCYAAucv8VY' },
    { packIndex: 65, label: '握拳抗议', sourceFileNumber: 33, emoji: '🧢', fileUniqueId: 'AgADQiEAAuMo-VY' },
    { packIndex: 66, label: '仰面躺平', sourceFileNumber: 63, emoji: '🪂', fileUniqueId: 'AgAD9iYAAn3U8FY' },
    { packIndex: 67, label: '挥舞荧光棒', sourceFileNumber: 58, emoji: '🪄', fileUniqueId: 'AgADnyEAArto8FY' },
    { packIndex: 68, label: '拿着逗猫棒', sourceFileNumber: 25, emoji: '🪶', fileUniqueId: 'AgAD2CQAAr6Y8FY' },
    { packIndex: 69, label: '趴地躺平', sourceFileNumber: 19, emoji: '🫠', fileUniqueId: 'AgADhyMAAk7-8FY' },
    { packIndex: 70, label: '害羞捂脸', sourceFileNumber: 18, emoji: '🫣', fileUniqueId: 'AgADBSIAAoLd8FY' },
    { packIndex: 71, label: '惊恐发抖', sourceFileNumber: 16, emoji: '🫨', fileUniqueId: 'AgAD5hwAAhcJ8VY' },
    { packIndex: 72, label: '藏在云朵里', sourceFileNumber: 24, emoji: '☁', fileUniqueId: 'AgADLSoAAri58FY' },
];

/** Trim and drop separators so "第 7 张" / "07" / "#7" all normalize the same way */
export const normalizeStickerQuery = (raw: string): string =>
    raw
        .trim()
        .replace(/\.png$/i, '')
        .replace(/^#/, '')
        .replace(/^第/, '')
        .replace(/张$/, '')
        // An original-filename prefix is never a pack index: drop it and match the label
        .replace(/^\d+[_＿]/, '')
        .replace(/^0+(?=\d)/, '')
        .replace(/\s+/g, '');

export const findStickerByPackIndex = (packIndex: number): StickerCatalogEntry | undefined =>
    STICKER_CATALOG.find((entry) => entry.packIndex === packIndex);

export const findStickerByLabel = (label: string): StickerCatalogEntry | undefined => {
    const query = normalizeStickerQuery(label);
    if (query === '') return undefined;
    return STICKER_CATALOG.find((entry) => normalizeStickerQuery(entry.label) === query);
};

/** Exact label first, then a unique contains match ("托腮" is ambiguous). */
export const searchStickersByLabel = (raw: string): readonly StickerCatalogEntry[] => {
    const query = normalizeStickerQuery(raw);
    if (query === '') return [];
    const exact = STICKER_CATALOG.filter((entry) => normalizeStickerQuery(entry.label) === query);
    if (exact.length > 0) return exact;
    return STICKER_CATALOG.filter((entry) => normalizeStickerQuery(entry.label).includes(query));
};

/** The catalog as the model reads it: `01闭眼微笑、02趴着等待、…` */
export const STICKER_CATALOG_TEXT: string = STICKER_CATALOG.map(
    (entry) =>
        `${String(entry.packIndex).padStart(2, '0')}${entry.label}` +
        (entry.duplicateOf === undefined ? '' : `（与 ${String(entry.duplicateOf).padStart(2, '0')} 相同）`)
).join('、');
