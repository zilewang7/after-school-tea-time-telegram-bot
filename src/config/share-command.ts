/** Share commands switch: on unless SHARE_COMMAND=0 / SHARE_ENABLED=0 / no public URL */
export const shareCommandEnabled = (): boolean =>
    process.env.SHARE_COMMAND !== '0'
    && process.env.SHARE_ENABLED !== '0'
    && (process.env.WEBAPP_PUBLIC_URL ?? '').trim() !== '';
