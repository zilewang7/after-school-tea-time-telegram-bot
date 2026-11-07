/**
 * The settings service's rejections as panel errors: its codes map one to one
 * (invalid 400, forbidden / locked 403, conflict 409) and its messages are
 * already meant for people.
 */
import { ChatSettingsError } from '../../services/chat-settings-service.js';
import { PanelError } from '../errors.js';

export const rethrowSettingsError = (error: unknown): never => {
    if (error instanceof ChatSettingsError) throw new PanelError(error.code, error.message);
    throw error;
};
