/**
 * Connects MiMo media preparation hooks (ai layer) to the concrete GCS signing
 * and video transcoding services without introducing an ai -> services edge.
 */
import { registerMimoMediaHooks } from '../ai/platforms/mimo-media.js';
import { createSignedReadUrl } from './gcs-service.js';
import { transcodeVideoToMp4 } from './tgs-client.js';

/** Register the production GCS read-URL signer and MP4 transcoder for MiMo media. */
export const installMimoMediaHooks = (): void => {
    registerMimoMediaHooks({
        createSignedReadUrl,
        transcodeVideoToMp4,
    });
};
