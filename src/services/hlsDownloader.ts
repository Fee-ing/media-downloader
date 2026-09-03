// hlsDownloader.ts
// 下载 HLS(.m3u8) 并转封装为可播放文件：先下载所有分片拼成完整 TS，再用纯 JS 转封装为 .mp4，
// 若转封装失败则兜底保存为 .ts（VLC / IINA / MX Player 均可播放）。

import * as FileSystem from 'expo-file-system';
import { File } from 'expo-file-system';
import { remuxTsToMp4, concatBytes, bytesToBase64 } from './tsRemuxer';

export interface HlsDownloadOptions {
  onProgress?: (pct: number, phase?: string) => void;
  signal?: AbortSignal;
}

interface ParsedM3U8 {
  isMaster: boolean;
  variants: { uri: string; bandwidth: number }[];
  segments: { uri: string }[];
  key?: { uri: string; method: string };
}

export function parseM3U8(text: string, baseUrl: string): ParsedM3U8 {
  const lines = text.split(/\r?\n/);
  const variants: { uri: string; bandwidth: number }[] = [];
  const segments: { uri: string }[] = [];
  let key: { uri: string; method: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const m = /BANDWIDTH=(\d+)/.exec(line);
      const bw = m ? parseInt(m[1], 10) : 0;
      const uri = lines[i + 1]?.trim();
      if (uri && !uri.startsWith('#')) variants.push({ uri, bandwidth: bw });
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const mm = /METHOD=([^,]+)/.exec(line);
      const um = /URI="([^"]+)"/.exec(line);
      if (mm && um) key = { uri: um[1], method: mm[1] };
    } else if (line.startsWith('#EXTINF:')) {
      const uri = lines[i + 1]?.trim();
      if (uri && !uri.startsWith('#')) segments.push({ uri });
    }
  }
  return { isMaster: variants.length > 0, variants, segments, key };
}

export function resolveUrl(base: string, rel: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return rel;
  try {
    return new URL(rel, base).toString();
  } catch {
    return rel;
  }
}

async function fetchText(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`m3u8 请求失败 ${res.status}: ${url}`);
  return res.text();
}

async function fetchBytes(url: string, headers: Record<string, string>): Promise<Uint8Array> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`分片请求失败 ${res.status}: ${url}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function writeBytes(path: string, data: Uint8Array): Promise<void> {
  await FileSystem.writeAsStringAsync(path, bytesToBase64(data), {
    encoding: FileSystem.EncodingType.Base64,
  });
}

export async function downloadHls(
  item: { url: string; headers?: Record<string, string> },
  file: File,
  headers: Record<string, string>,
  options: HlsDownloadOptions = {},
): Promise<File> {
  const { onProgress } = options;
  const effHeaders: Record<string, string> = { ...(headers || {}), ...(item.headers || {}) };
  onProgress?.(0, '解析 m3u8 播放列表…');

  const masterText = await fetchText(item.url, effHeaders);
  const master = parseM3U8(masterText, item.url);

  let variantText: string;
  let variantBase: string;
  if (master.isMaster) {
    const v = master.variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0] || master.variants[0];
    if (!v) throw new Error('m3u8 未找到可用变体');
    variantBase = resolveUrl(item.url, v.uri);
    variantText = await fetchText(variantBase, effHeaders);
  } else {
    variantBase = item.url;
    variantText = masterText;
  }

  const pl = parseM3U8(variantText, variantBase);
  if (pl.key && /AES-128/i.test(pl.key.method)) {
    throw new Error('该 HLS 使用 AES-128 加密，纯 JS 暂不支持，请改用 FFmpeg 方案');
  }

  const segUrls = pl.segments.map((s) => resolveUrl(variantBase, s.uri));
  const total = segUrls.length;
  if (total === 0) throw new Error('m3u8 未解析到分片');

  const parts: Uint8Array[] = new Array(total);
  let done = 0;
  const limit = 4;
  let idx = 0;
  async function worker() {
    while (idx < total) {
      const cur = idx++;
      parts[cur] = await fetchBytes(segUrls[cur], effHeaders);
      done++;
      onProgress?.(Math.floor((done / total) * 90), `下载分片 ${done}/${total}`);
    }
  }
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, total); w++) workers.push(worker());
  await Promise.all(workers);

  onProgress?.(92, '封装为 MP4…');
  const ts = concatBytes(parts.filter(Boolean));

  let outFile: File = file;
  try {
    const mp4 = remuxTsToMp4(ts);
    await writeBytes(file.uri, mp4);
    onProgress?.(100, '完成');
  } catch (e) {
    const base = file.name.replace(/\.[^.]+$/, '');
    outFile = new File(file.parentDirectory, `${base}.ts`);
    await writeBytes(outFile.uri, ts);
    onProgress?.(100, 'MP4 封装失败，已保存为 .ts（可直接用播放器播放）');
  }
  return outFile;
}
