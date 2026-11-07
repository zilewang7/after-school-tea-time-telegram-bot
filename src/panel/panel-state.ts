/**
 * Whether the panel server is up. Kept free of imports so the `/panel`
 * command can ask without loading the HTTP app.
 */
let running = false;

export const setPanelRunning = (value: boolean): void => {
    running = value;
};

/** WEBAPP_PORT is set and the server is listening */
export const isPanelRunning = (): boolean => running;
