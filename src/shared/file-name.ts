/**
 * File-name helpers shared by the reply tools and the workspace service.
 *
 * They live in the lowest layer because both the reply tools (which send a file
 * into the chat) and the services layer (which stores workspace files) need the
 * same extension → MIME table and the same model-facing size format. The reply
 * tool module re-exports them, so its existing importers stay unchanged.
 */

const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
    ['md', 'text/markdown'],
    ['markdown', 'text/markdown'],
    ['txt', 'text/plain'],
    ['text', 'text/plain'],
    ['log', 'text/plain'],
    ['json', 'application/json'],
    ['csv', 'text/csv'],
    ['tsv', 'text/tab-separated-values'],
    ['html', 'text/html'],
    ['htm', 'text/html'],
    ['xml', 'application/xml'],
    ['yaml', 'application/yaml'],
    ['yml', 'application/yaml'],
    ['toml', 'application/toml'],
    ['js', 'text/javascript'],
    ['mjs', 'text/javascript'],
    ['cjs', 'text/javascript'],
    ['css', 'text/css'],
    ['py', 'text/x-python'],
    ['sh', 'application/x-sh'],
    ['bash', 'application/x-sh'],
    ['sql', 'application/sql'],
    ['svg', 'image/svg+xml'],
    ['ini', 'text/plain'],
]);

/** The last path segment of a workspace-style path: the file's own name */
export const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The last extension of a name, lowercased; empty when it has none */
export const extensionOf = (name: string): string => {
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) return '';
    return name.slice(dot + 1).toLowerCase();
};

/** MIME from the extension; text/plain for anything unknown (the content is text) */
export const mimeForFileName = (name: string): string =>
    MIME_BY_EXTENSION.get(extensionOf(name)) ?? 'text/plain';

/** `512 B`, `12.4 KB`, `1.5 MB` — the model and the chat both read this */
export const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};
