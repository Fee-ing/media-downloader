import { LIMITS } from '../constants';
import type { FilterState, MediaItem, RawScrapePayload } from '../types';
import { fileNameFromUrl } from '../utils/url';

function shortTitle(raw: string | undefined, url: string): string {
  const text = (raw || '').trim();
  if (text) return text.slice(0, 120);
  return fileNameFromUrl(url);
}

export function buildMediaItems(payload: RawScrapePayload): {
  images: MediaItem[];
  videos: MediaItem[];
} {
  const images: MediaItem[] = [];
  const videos: MediaItem[] = [];
  const seen = new Set<string>();

  (payload.images || []).forEach((raw, index) => {
    if (!raw?.url || seen.has(`i${raw.url}`)) return;
    seen.add(`i${raw.url}`);
    images.push({
      id: `img-${index}`,
      kind: 'image',
      url: raw.url,
      title: shortTitle(raw.title, raw.url),
      width: raw.w || undefined,
      height: raw.h || undefined,
      size: raw.size || undefined,
      source: raw.source,
    });
    if (images.length >= LIMITS.IMAGES) return;
  });

  (payload.videos || []).forEach((raw, index) => {
    if (!raw?.url || seen.has(`v${raw.url}`)) return;
    seen.add(`v${raw.url}`);
    videos.push({
      id: `vid-${index}`,
      kind: 'video',
      url: raw.url,
      poster: raw.poster || undefined,
      title: shortTitle(raw.title, raw.url),
      width: raw.w || undefined,
      height: raw.h || undefined,
      duration: raw.duration || undefined,
      size: raw.size || undefined,
      source: raw.source,
      contentType: raw.contentType || undefined,
      fallbackUrl: raw.fallbackUrl || undefined,
      headers: raw.headers || undefined,
      viaNetwork: raw.viaNetwork,
      pageProbeOk: raw.probeOk,
    });
    if (videos.length >= LIMITS.VIDEOS) return;
  });

  return { images, videos };
}

/** 像素总量：图片的「尺寸」、视频的「分辨率」 */
function pixelArea(item: MediaItem): number {
  return (item.width ?? 0) * (item.height ?? 0);
}

/** 不可播放的资源沉到最后 */
function playableRank(item: MediaItem): number {
  return item.playback === 'unplayable' ? 0 : 1;
}

export interface SortContext {
  keyword: string;
}

export function filterAndSort<T extends MediaItem>(items: T[], filter: FilterState): T[] {
  const keyword = filter.keyword.trim().toLowerCase();
  const filtered = keyword
    ? items.filter(
        item =>
          item.title.toLowerCase().includes(keyword) ||
          item.url.toLowerCase().includes(keyword),
      )
    : [...items];

  // 默认排序：可播放的优先，其次图片按尺寸、视频按分辨率从大到小；尺寸缺失时回退到文件体积。
  // 体积探测完成后会重建数组，此处会自动重排。
  if (filter.sortField === 'default') {
    return filtered.sort(
      (a, b) =>
        playableRank(b) - playableRank(a) ||
        pixelArea(b) - pixelArea(a) ||
        (b.size ?? 0) - (a.size ?? 0),
    );
  }

  const dir = filter.sortOrder === 'asc' ? 1 : -1;
  const valueOf = (item: MediaItem): number | string => {
    switch (filter.sortField) {
      case 'size':
        return item.size ?? -1;
      case 'dimension':
        return pixelArea(item);
      case 'duration':
        return item.duration ?? -1;
      case 'title':
        return item.title.toLowerCase();
      default:
        return 0;
    }
  };

  return filtered.sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va).localeCompare(String(vb)) * dir;
    }
    return (va - vb) * dir;
  });
}
