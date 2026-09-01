/**
 * Decide which buttons a finalized response ships with.
 *
 * Version switching earns a keyboard only when there is a version worth
 * switching to. A history of bodyless failures (errors/stops that produced no
 * text and no image) followed by one clean version with content offers
 * nothing to switch to and nothing worth retrying — no keyboard at all.
 */
import { match } from 'ts-pattern';
import { ButtonState, type ResponseVersion } from '../db/botResponseDTO.js';

/** A version with neither text nor an image gives switching nothing to show */
const hasBody = (version: ResponseVersion): boolean =>
    Boolean(version.text.trim() || version.imageBase64);

export interface FinalButtonStateInput {
    /** All versions, current one included as the last element */
    versions: ResponseVersion[];
    /** The run that just finalized errored or was stopped by the user */
    hasError: boolean;
    /** The user edited their message while we were generating */
    editedWhileProcessing: boolean;
}

export const decideFinalButtonState = (input: FinalButtonStateInput): ButtonState => {
    const { versions, hasError, editedWhileProcessing } = input;
    const current = versions[versions.length - 1];
    const earlier = versions.slice(0, -1);

    const currentIsCleanWithBody = !hasError && current !== undefined && hasBody(current);
    const onlyBodylessFailuresBefore =
        currentIsCleanWithBody && earlier.every((version) => !hasBody(version));
    const hasSwitchableVersions = versions.length > 1 && !onlyBodylessFailuresBefore;

    return match({ hasSwitchableVersions, hasError, editedWhileProcessing })
        .with({ hasSwitchableVersions: true }, () => ButtonState.HAS_VERSIONS)
        .with({ hasError: true }, () => ButtonState.RETRY_ONLY)
        .with({ editedWhileProcessing: true }, () => ButtonState.EDIT_DETECTED)
        .otherwise(() => ButtonState.NONE);
};
