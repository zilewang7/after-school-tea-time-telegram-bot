/**
 * Pure InlineKeyboard builders for bot response messages (stop, retry,
 * continue, version navigation). Lives in L2 telegram/ so services and
 * delivery layers can build keyboards without importing L3 cmd/menus.
 */
import { InlineKeyboard } from 'grammy';
import { match } from 'ts-pattern';
import { ButtonState } from '../db/index.js';

/** Callback data prefix shared with the response callback handler */
export const RESPONSE_CALLBACK_PREFIX = 'resp:';

export interface ResponseButtonOptions {
    /**
     * The version on screen is a failed or stopped latest version whose
     * checkpoint is kept: offer "继续" next to "重试"
     */
    readonly resumable?: boolean;
}

/** "继续" in front of the rest of the row, when the version can be continued */
const keyboardStartingWithContinue = (resumable: boolean): InlineKeyboard => {
    const keyboard = new InlineKeyboard();
    if (resumable) keyboard.text('继续', `${RESPONSE_CALLBACK_PREFIX}continue`);
    return keyboard;
};

/**
 * Build InlineKeyboard based on button state.
 * Uses simple callback_data format: resp:action
 */
export const buildResponseButtons = (
    buttonState: ButtonState,
    currentVersionIndex: number = 0,
    totalVersions: number = 1,
    options: ResponseButtonOptions = {}
): InlineKeyboard | undefined => {
    const resumable = options.resumable === true;
    return match(buttonState)
        .with(ButtonState.PROCESSING, () =>
            new InlineKeyboard().text('停止', `${RESPONSE_CALLBACK_PREFIX}stop`)
        )
        .with(ButtonState.RETRY_ONLY, () =>
            keyboardStartingWithContinue(resumable).text('重试', `${RESPONSE_CALLBACK_PREFIX}retry`)
        )
        // An edit does not block continuing (D11): the user picks either
        .with(ButtonState.EDIT_DETECTED, () =>
            keyboardStartingWithContinue(resumable).text('检测到用户编辑，是否重试', `${RESPONSE_CALLBACK_PREFIX}retry`)
        )
        .with(ButtonState.HAS_VERSIONS, () => {
            const kb = new InlineKeyboard();

            if (currentVersionIndex > 0) {
                kb.text('<', `${RESPONSE_CALLBACK_PREFIX}prev`);
            }

            if (resumable) {
                kb.text('继续', `${RESPONSE_CALLBACK_PREFIX}continue`);
            }

            kb.text('重试', `${RESPONSE_CALLBACK_PREFIX}retry`);

            if (currentVersionIndex < totalVersions - 1) {
                kb.text('>', `${RESPONSE_CALLBACK_PREFIX}next`);
            }

            return kb;
        })
        .otherwise(() => undefined);
};
