/**
 * OCR fallback check — needs a TEXT-ONLY model, so it lives outside the main
 * suite. Models are set per chat and any id is accepted, so it switches the
 * test group to one with `/model` and puts it back with `/model default`; no
 * env change, no container recreate.
 *
 * Prerequisite: the test container is up
 * (docker compose --profile test up -d k-on-bot-test), then pnpm test:e2e:ocr.
 *
 * The image carries nothing but the fixture string and the model cannot see it,
 * so answering correctly is only possible through the stored OCR text.
 */
import {
    BOT_USERNAME,
    expect,
    sendPhotoAsUser,
    waitForBotResponse,
    waitForStoredOcrText,
} from './harness.mts';
import { resetModelToDefault, setModelByCommand } from './suite-helpers.mts';

/** Text-only: its capabilities have supportsImageInput false */
const TEXT_ONLY_MODEL = 'mimo-v2.5-pro';

const FIXTURE = 'ocr-sample.png';
const FIXTURE_TEXT = 'OCR-TEST-XYZ789';

await setModelByCommand(TEXT_ONLY_MODEL);
try {
    const picture = await sendPhotoAsUser(FIXTURE, {
        caption: `@${BOT_USERNAME} 图里写的那串字符是什么?只回答那串字符本身`,
    });
    console.log(`▶ sent picture ${picture}`);

    const ocrText = await waitForStoredOcrText(picture);
    expect(ocrText.includes(FIXTURE_TEXT), `OCR stored (got: ${ocrText.slice(0, 80)})`);

    const response = await waitForBotResponse(picture);
    expect(!response.errorMessage, `no error (got: ${response.errorMessage ?? ''})`);
    expect(
        response.text.includes(FIXTURE_TEXT),
        `a text-only model answered from the OCR fallback (got: ${response.text.slice(0, 120)})`
    );
    console.log('\nPASS  OCR fallback reaches a model that cannot see images');
} finally {
    await resetModelToDefault();
}
