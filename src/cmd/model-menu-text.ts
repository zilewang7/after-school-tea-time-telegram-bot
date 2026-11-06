/**
 * Text of the /model menu, built as entities. A model id is free text and may
 * hold any character; a backtick in it broke the old legacy-Markdown message
 * with a 400, entities never need escaping.
 */
import { match } from 'ts-pattern';
import { concatMessages, type RenderedMessage } from 'telegram-md-entities';
import { codeText, plainText } from '../telegram/formatters/entity-text.js';

/** Where a chat's model comes from */
export type ModelSource = 'global' | 'chat';

export interface ChatModelView {
    /** The model the chat replies with */
    model: string;
    source: ModelSource;
}

export interface ModelSwitchView {
    current: ChatModelView;
    previousModel: string;
    /** See formatActionTime */
    actionTime: string;
}

const FOOTER: RenderedMessage = concatMessages(
    plainText('\n\n只对本聊天生效。点击下方按钮快速切换或使用 '),
    codeText('/model '),
    plainText('+模型名 手动指定')
);

const sourceNoteOf = (source: ModelSource): string =>
    match(source)
        .with('global', () => '（跟随全局默认）')
        .with('chat', () => '（本聊天单独设置）')
        .exhaustive();

/** Clock time of a change, always labeled with the zone it is shown in */
export const formatActionTime = (date: Date = new Date()): string => {
    const timeZone = process.env.TZ || 'Asia/Shanghai';
    return `${date.toLocaleTimeString('zh-CN', { hour12: false, timeZone })} ${timeZone}`;
};

/** `/model` without an argument: the chat's model and where it comes from */
export const renderModelOverview = (current: ChatModelView): RenderedMessage =>
    concatMessages(
        plainText('当前模型：'),
        codeText(current.model),
        plainText(sourceNoteOf(current.source)),
        FOOTER
    );

/**
 * After a change. Only "follow the global default" is marked: a chat's own
 * model is what the user just picked, so it needs no note.
 */
export const renderModelSwitch = (change: ModelSwitchView): RenderedMessage =>
    concatMessages(
        plainText('切换为：'),
        codeText(change.current.model),
        plainText(change.current.source === 'global' ? sourceNoteOf('global') : ''),
        plainText('\n上一个模型：'),
        codeText(change.previousModel),
        plainText('\n操作时间：'),
        codeText(change.actionTime),
        FOOTER
    );
