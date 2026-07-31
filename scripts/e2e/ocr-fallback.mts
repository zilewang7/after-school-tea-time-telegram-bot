/**
 * OCR fallback check — needs a TEXT-ONLY model, so it lives outside the main
 * suite (which runs on whatever DEFAULT_MODEL the test instance has).
 *
 * Prerequisites:
 *   1. .env.test → DEFAULT_MODEL=deepseek-v4-flash (or another model whose
 *      capabilities have supportsImageInput: false)
 *   2. docker compose --profile test up -d --force-recreate k-on-bot-test
 *   3. pnpm test:e2e:ocr
 *   4. restore DEFAULT_MODEL and recreate the container again
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

const FIXTURE = 'ocr-sample.png';
const FIXTURE_TEXT = 'OCR-TEST-XYZ789';

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
