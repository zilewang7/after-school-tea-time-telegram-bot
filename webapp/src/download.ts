/** Save text as a file; returns false when the client refuses to start the download */
export const downloadTextFile = (text: string, fileName: string, contentType: string | null): boolean => {
    try {
        const blob = new Blob([text], { type: contentType ?? 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.rel = 'noopener';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        // Revoked late: some WebViews read the blob after the click handler returns
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return true;
    } catch {
        return false;
    }
};
