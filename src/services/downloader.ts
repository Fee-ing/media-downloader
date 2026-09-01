import { Directory, File, Paths } from 'expo-file-system';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { Platform } from 'react-native';

import { DESKTOP_UA } from '../constants';
import type { MediaItem } from '../types';
import { buildFileName } from '../utils/url';
import { muxFragmentedMp4Files } from './mp4Muxer';

export type SaveResult = 'gallery' | 'shared' | 'file';

export interface DownloadOptions {
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  referer?: string;
}

const DOWNLOAD_DIR = 'media-downloader';

function getDownloadDir(): Directory {
  const dir = new Directory(Paths.document, DOWNLOAD_DIR);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function uniqueName(dir: Directory, name: string): string {
  if (!new File(dir, name).exists) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${base}-${Date.now()}${ext}`;
}

export interface DownloadedFile {
  uri: string;
  saved: SaveResult;
}

function buildHeaders(item: MediaItem, options: DownloadOptions): Record<string, string> {
  return {
    'User-Agent': DESKTOP_UA,
    ...(options.referer ? { Referer: options.referer } : {}),
    // 校验阶段记录下来的同源 Cookie / Origin 等，用于突破防盗链
    ...(item.headers || {}),
  };
}

/** 下载单个文件到指定路径，返回下载完成的 File */
async function downloadSingle(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  const task = File.createDownloadTask(url, file, {
    headers,
    onProgress: ({ bytesWritten, totalBytes }) => {
      if (totalBytes > 0) {
        onProgress?.(Math.min(0.99, bytesWritten / totalBytes));
      }
    },
    signal,
    sessionType: 'foreground',
  });

  const result = await task.downloadAsync();
  if (!result) {
    throw new Error('下载失败：未生成本地文件');
  }
  return result;
}

/** 将 onProgress 映射到 [from, to] 区间，用于分段汇报整体进度 */
function scaledProgress(
  onProgress: ((progress: number) => void) | undefined,
  from: number,
  to: number,
): (progress: number) => void {
  return progress => {
    onProgress?.(from + Math.min(1, Math.max(0, progress)) * (to - from));
  };
}

function getAudioUris(item: MediaItem): string[] {
  if (item.audioTrackUrls && item.audioTrackUrls.length) return item.audioTrackUrls;
  if (item.audioTrackUrl) return [item.audioTrackUrl];
  return [];
}

const M4S_URL_RE = /\.(m4s|m4a)([?#]|$)/i;
// 判断是否为「音画分离、需要合并成单个 MP4」的 DASH 资源。
// 不依赖具体站点或扩展名：只要候选配对了独立音轨，且视频轨是分片容器
// （.m4s/.m4a）或已被识别为 DASH（streamKind），就走合并路径。各站改版后的直链
// 常不带扩展名，所以「配了独立音轨」本身就是最可靠的分离信号。
const isSeparatedDash = (item: MediaItem): boolean => {
  // 运行时 MediaItem 可能只带单值 audioTrackUrl（部分站点适配只填了单值），
  // 所以单值也要计入，不能只看 audioTrackUrls 数组。
  const hasAudio =
    (Array.isArray(item.audioTrackUrls) && item.audioTrackUrls.length > 0) ||
    !!item.audioTrackUrl;
  if (!hasAudio) return false;
  return (
    M4S_URL_RE.test(item.url) ||
    item.streamKind === 'dash'
  );
};

/**
 * DASH 音画分离资源（视频轨 m4s/m4a + 独立伴音轨）：
 * 下载视频轨与音轨，用纯 JS 合并器合并成单个 MP4（含画面 + 声音）。
 * 多音轨时按序尝试，全部失败则回退为「仅下载视频轨」（保持旧行为）。
 */
async function downloadMuxed(
  item: MediaItem,
  audioUris: string[],
  file: File,
  headers: Record<string, string>,
  options: DownloadOptions,
): Promise<File> {
  const tmpDir = new Directory(Paths.cache, 'media-downloader-mux');
  tmpDir.create({ intermediates: true, idempotent: true });
  const stamp = `${Date.now()}`;
  const videoTmp = new File(tmpDir, `video-${stamp}.m4s`);
  const audioTmp = new File(tmpDir, `audio-${stamp}.m4s`);

  // 合并产物扩展名统一为 .mp4，确保相册能正确识别为视频
  const destination = file.extension.toLowerCase() === '.mp4' ? file : new File(file.parentDirectory, `${file.name.replace(/\.[^.]*$/, '')}.mp4`);
  if (destination.exists) destination.delete();

  try {
    // 1. 视频轨：0% - 40%
    await downloadSingle(item.url, videoTmp, headers, scaledProgress(options.onProgress, 0, 0.4), options.signal);

    // 2. 音轨（40% - 75%）+ 合并（75% - 95%）：多音轨逐个尝试
    let lastError: unknown;
    for (const audioUrl of audioUris) {
      try {
        await downloadSingle(audioUrl, audioTmp, headers, scaledProgress(options.onProgress, 0.4, 0.75), options.signal);
        await muxFragmentedMp4Files(videoTmp, audioTmp, destination, scaledProgress(options.onProgress, 0.75, 0.95));
        options.onProgress?.(0.95);
        return destination;
      } catch (error) {
        lastError = error;
        console.warn('[downloader] 伴音轨合并失败，尝试下一条音轨：', error);
        if (audioTmp.exists) audioTmp.delete();
      }
    }
    throw lastError ?? new Error('音轨合并失败');
  } catch (error) {
    // 合并失败：回退为仅下载视频轨（保留旧行为）
    if (destination.exists) destination.delete();
    console.warn('[downloader] DASH 合并失败，回退为仅下载视频轨：', error);
    await downloadSingle(item.url, file, headers, options.onProgress, options.signal);
    return file;
  } finally {
    if (videoTmp.exists) videoTmp.delete();
    if (audioTmp.exists) audioTmp.delete();
  }
}

/** 下载单个媒体文件，并尝试保存到系统相册 */
export async function downloadMedia(
  item: MediaItem,
  options: DownloadOptions = {},
): Promise<DownloadedFile> {
  // HLS/DASH 需要拉取并合并分片，直接下载清单文件没有意义
  if (item.downloadable === false) {
    throw new Error(item.playbackNote || '该资源暂不支持直接下载');
  }

  const dir = getDownloadDir();
  const fallbackExt = item.kind === 'image' ? '.jpg' : (item.format ? `.${item.format}` : '.mp4');
  const name = buildFileName(item.url, item.title, fallbackExt);
  const file = new File(dir, uniqueName(dir, name));

  if (file.exists) {
    file.delete();
  }

  const headers = buildHeaders(item, options);
  const audioUris = getAudioUris(item);

  // DASH 音画分离（配对了独立伴音轨的视频轨）：合并成单个 MP4 再下载
  const separated = isSeparatedDash(item);
  console.log('[DL]', { separated, hasAudio: audioUris.length > 0, audioCount: audioUris.length, url: item.url, headers });

  const target = separated
    ? await downloadMuxed(item, audioUris, file, headers, options)
    : await downloadSingle(item.url, file, headers, options.onProgress, options.signal);

  options.onProgress?.(1);
  const saved = await saveToGallery(target.uri);
  return { uri: target.uri, saved };
}

/**
 * 保存到系统相册（照片/视频），失败时降级为系统分享（用户可自行存储）。
 *
 * 注意：Expo Go 运行时不包含 `expo-media-library` 的原生模块（`ExpoMediaLibraryNext`），
 * 而该包在顶层就 `requireNativeModule` 加载原生模块，一旦 `import/require` 该 JS 包就会
 * 直接抛错崩溃。因此我们**不能**引入 `expo-media-library` 包，只能用
 * `requireOptionalNativeModule('ExpoMediaLibraryNext')` 直接探测原生对象：
 *   - 原生模块存在（dev client / 自定义构建）：调 `requestPermissionsAsync` + `Asset.create` 存入相册；
 *   - 原生模块缺失（Expo Go）：探测为 null，干净降级到 `expo-sharing` 系统分享。
 */
export async function saveToGallery(uri: string): Promise<SaveResult> {
  const MediaLibrary = requireOptionalNativeModule('ExpoMediaLibraryNext');

  if (MediaLibrary != null) {
    try {
      const permission = await MediaLibrary.requestPermissionsAsync(true);
      if (permission?.granted && MediaLibrary.Asset?.create) {
        await MediaLibrary.Asset.create(uri);
        return 'gallery';
      }
      if (!permission?.granted) {
        console.warn('[downloader] 用户未授予相册权限，降级为系统分享');
      }
    } catch (error) {
      console.warn('[downloader] 保存到相册失败，尝试降级：', error);
    }
  }

  try {
    if (await isAvailableAsync()) {
      await shareAsync(uri);
      return 'shared';
    }
  } catch (error) {
    console.warn('[downloader] 系统分享不可用：', error);
  }

  return 'file';
}

export function saveResultText(result: SaveResult): string {
  if (result === 'gallery') return '已保存到相册';
  if (result === 'shared') return '已通过系统分享保存';
  return '已保存到应用目录';
}
