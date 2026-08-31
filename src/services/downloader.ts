import { Directory, File, Paths } from 'expo-file-system';

import { DESKTOP_UA } from '../constants';
import type { MediaItem } from '../types';
import { buildFileName } from '../utils/url';

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

  const task = File.createDownloadTask(item.url, file, {
    headers: {
      'User-Agent': DESKTOP_UA,
      ...(options.referer ? { Referer: options.referer } : {}),
      // 校验阶段记录下来的同源 Cookie / Origin 等，用于突破防盗链
      ...(item.headers || {}),
    },
    onProgress: ({ bytesWritten, totalBytes }) => {
      if (totalBytes > 0) {
        options.onProgress?.(Math.min(0.99, bytesWritten / totalBytes));
      }
    },
    signal: options.signal,
    sessionType: 'foreground',
  });

  const result = await task.downloadAsync();
  if (!result) {
    throw new Error('下载失败：未生成本地文件');
  }
  options.onProgress?.(1);
  const saved = await saveToGallery(result.uri);
  return { uri: result.uri, saved };
}

/**
 * 保存到相册，失败时降级为系统分享（用户可自行存储）。
 *
 * 依赖按需 require：部分运行环境（如未预构建原生模块的 Expo Go）
 * 不存在 `ExpoMediaLibraryNext` 原生模块，静态 import 会在 App 启动阶段直接崩溃。
 */
export async function saveToGallery(uri: string): Promise<SaveResult> {
  try {
    const MediaLibrary = require('expo-media-library');
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (permission?.granted && MediaLibrary.Asset?.create) {
      await MediaLibrary.Asset.create(uri);
      return 'gallery';
    }
  } catch (error) {
    console.warn('[downloader] 保存到相册失败，尝试降级：', error);
  }

  try {
    const Sharing = require('expo-sharing');
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri);
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
