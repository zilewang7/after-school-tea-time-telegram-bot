import { SocksProxyAgent } from 'socks-proxy-agent';
import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { buffer as readStreamToBuffer } from 'node:stream/consumers';
import type { Api } from 'grammy';

const DOWNLOAD_TIMEOUT_MS = 30000;
const localApiRoot = process.env.TG_LOCAL_API_ROOT;
const downloadProxyAgent = (!localApiRoot && process.env.BOT_PROXY)
  ? new SocksProxyAgent(process.env.BOT_PROXY)
  : undefined;
const cloudFileBaseUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}`;
const fileBaseUrl = localApiRoot
  ? `${localApiRoot}/file/bot${process.env.BOT_TOKEN}`
  : cloudFileBaseUrl;

export type TelegramApiAbortSignal = Parameters<Api['getFile']>[1];

/** grammY currently exposes abort-controller's structural type instead of DOM AbortSignal. */
export const toTelegramApiAbortSignal = (
  signal: AbortSignal | undefined
): TelegramApiAbortSignal => signal as unknown as TelegramApiAbortSignal;

export interface TelegramFileClient {
  api: {
    getFile(
      fileId: string,
      signal?: TelegramApiAbortSignal
    ): Promise<{ file_path?: string }>;
  };
}

export type ResolvedTelegramFile =
  | { kind: 'path'; path: string; sourcePath: string; size: number }
  | { kind: 'buffer'; bytes: Buffer; sourcePath: string };

const httpGetBuffer = (url: string, signal?: AbortSignal): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    // The local Bot API serves files over plain http; the cloud API over https
    const transport = url.startsWith('http://') ? http : https;
    const request = transport.get(
      url,
      { agent: downloadProxyAgent, timeout: DOWNLOAD_TIMEOUT_MS, signal },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`file download HTTP ${response.statusCode}`));
          return;
        }
        readStreamToBuffer(response).then(resolve, reject);
      }
    );
    request.on('timeout', () => request.destroy(new Error('file download timed out')));
    request.on('error', reject);
  });

/**
 * Download a relative getFile path. The self-hosted API sometimes returns a
 * path it has not put on disk (sticker thumbnails are one example), so a 404
 * from the local server falls back to the cloud file endpoint with the same
 * token and path. An absolute path is the local API's success shape and is
 * read directly.
 */
const fetchRelativeFile = async (filePath: string, signal?: AbortSignal): Promise<Buffer> => {
  const urls = [`${fileBaseUrl}/${filePath}`];
  if (localApiRoot) urls.push(`${cloudFileBaseUrl}/${filePath}`);

  let lastError: unknown;
  for (const url of urls) {
    try {
      return await httpGetBuffer(url, signal);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('file download failed');
};

export const resolveTelegramFile = async (
  bot: TelegramFileClient,
  fileId: string,
  signal?: AbortSignal
): Promise<ResolvedTelegramFile> => {
  const file = await bot.api.getFile(fileId, toTelegramApiAbortSignal(signal));
  const filePath = file.file_path;
  if (!filePath) throw new Error('getFile returned no file_path');

  if (filePath.startsWith('/')) {
    const info = await stat(filePath);
    return { kind: 'path', path: filePath, sourcePath: filePath, size: info.size };
  }

  const bytes = await fetchRelativeFile(filePath, signal);
  return { kind: 'buffer', bytes, sourcePath: filePath };
};

export const downloadTelegramFile = async (
  bot: TelegramFileClient,
  fileId: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; sourcePath: string }> => {
  const resolved = await resolveTelegramFile(bot, fileId, signal);
  return resolved.kind === 'path'
    ? { bytes: await readFile(resolved.path), sourcePath: resolved.sourcePath }
    : { bytes: resolved.bytes, sourcePath: resolved.sourcePath };
};

export const downloadTelegramFileBytes = async (bot: TelegramFileClient, fileId: string): Promise<Buffer> =>
  (await downloadTelegramFile(bot, fileId)).bytes;
