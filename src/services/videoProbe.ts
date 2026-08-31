import { Platform } from 'react-native';

import { LIMITS, TIMING } from '../constants';
import type { MediaItem, VideoPlaybackStatus, VideoStreamKind } from '../types';
import { requestHeaders } from '../utils/http';
import {
  acceptsRanges,
  detectFormat,
  fileNameOf,
  formatFromContentType,
  HLS_FORMATS,
  normalizeContentType,
  parseContentLength,
  parseContentRange,
  parseM3u8,
  pickBestVariant,
  sniffFormat,
} from './videoFormat';

/**
 * 视频可播放性校验。
 *
 * 页面里能“看到”的视频，常见以下几种拿不到/放不出的情况，这里逐一处理：
 * - blob:/data: 源（MSE 实时合成），没有可下载直链；
 * - 403/401：需要登录态或存在防盗链（补 Referer / 同源 Cookie 后重试）；
 * - 404/410：链接已失效（多为带时效签名的地址）；
 * - 返回 text/html：拿到的是网页（登录页/错误页），不是视频；
 * - HLS 主列表：本地能播，但记录下最佳清晰度地址作为兜底；
 * - HLS 加密（#EXT-X-KEY）：无法解密，直接判为不可播；
 * - DASH/容器格式当前平台不支持；
 * - 体积过小：占位图/广告素材。
 */

/** iOS（AVPlayer）可直接播放的容器 */
const IOS_PLAYABLE = ['mp4', 'm4v', 'mov', 'm4s', 'ts', 'm3u8', 'm3u'];
/** Android（ExoPlayer）额外支持的容器；ASF/WMV 不在其支持列表内 */
const ANDROID_EXTRA = ['webm', 'mkv', 'ogg', 'ogv', 'flv', 'avi', '3gp', '3gp2', 'f4v', 'mpg'];

function canPlayFormat(format: string): boolean {
  if (Platform.OS === 'ios') return IOS_PLAYABLE.indexOf(format) >= 0;
  return IOS_PLAYABLE.indexOf(format) >= 0 || ANDROID_EXTRA.indexOf(format) >= 0;
}

export interface VideoProbeContext {
  /** 抓取的页面地址，用于 Referer 与同源判定 */
  pageUrl?: string;
  /** 页面的 document.cookie（仅同源时携带） */
  pageCookie?: string;
  timeout?: number;
}

export interface VideoProbeResult {
  status: VideoPlaybackStatus;
  /** 给用户看的原因 / 提示 */
  note?: string;
  streamKind?: VideoStreamKind;
  format?: string;
  contentType?: string;
  size?: number;
  duration?: number;
  width?: number;
  height?: number;
  fallbackUrl?: string;
  downloadable: boolean;
  headers: Record<string, string>;
}

interface HttpResult {
  ok: boolean;
  status: number;
  /** 小写 key */
  headers: Record<string, string | undefined>;
  bytes?: Uint8Array;
}

function headerValue(headers: unknown, name: string): string | undefined {
  try {
    const holder = headers as { get?: (key: string) => string | null } | undefined;
    return holder?.get?.(name) ?? undefined;
  } catch {
    return undefined;
  }
}

function decodeText(bytes: Uint8Array): string {
  try {
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(bytes);
    }
  } catch {
    /* 降级到手动解码 */
  }
  let out = '';
  const chunk = 4096;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = Array.prototype.slice.call(bytes.subarray(i, i + chunk));
    out += String.fromCharCode.apply(null, slice as number[]);
  }
  return out;
}

async function request(
  url: string,
  init: { method: 'GET' | 'HEAD'; headers: Record<string, string> },
  timeout: number,
): Promise<HttpResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* noop */
    }
  }, timeout);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const headers: Record<string, string | undefined> = {};
    const keys = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'content-disposition',
    ];
    keys.forEach(key => {
      headers[key] = headerValue(response.headers, key);
    });
    let bytes: Uint8Array | undefined;
    if (init.method === 'GET') {
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        bytes = undefined;
      }
    }
    return { ok: response.ok, status: response.status, headers, bytes };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    try {
      controller.abort();
    } catch {
      /* noop */
    }
  }
}

function unsupportedUrlNote(url: string): string {
  if (url.indexOf('blob:') === 0) {
    return '该视频由网页脚本实时合成（内存流），没有可下载的直链';
  }
  if (url.indexOf('data:') === 0) return '该视频是页面内嵌数据，无法作为文件下载';
  return '不支持的地址协议，无法播放或下载';
}

function statusNote(status: number, pageProbeOk?: boolean): string {
  let note: string;
  if (status === 401 || status === 403) {
    note = '需要登录或存在防盗链，无法直接播放/下载';
  } else if (status === 404 || status === 410) {
    note = '资源已失效（链接可能带有时效签名）';
  } else if (status === 405 || status === 501) {
    note = '服务器不支持该请求方式';
  } else {
    note = `服务器返回 HTTP ${status}`;
  }
  if (pageProbeOk) {
    note += '（网页内可播放，通常依赖登录态或 Referer 校验）';
  }
  return note;
}

/** 读取 HLS/DASH 清单（限制体积，避免拉取超大文件） */
async function fetchManifest(
  url: string,
  headers: Record<string, string>,
  timeout: number,
): Promise<{ text: string; total?: number } | null> {
  const res = await request(
    url,
    { method: 'GET', headers: { ...headers, Range: `bytes=0-${LIMITS.PLAYLIST_BYTES - 1}` } },
    timeout,
  );
  if (!res || !res.bytes || !res.ok) return null;
  const total =
    parseContentRange(res.headers['content-range']) ??
    parseContentLength(res.headers['content-length']);
  return { text: decodeText(res.bytes), total };
}

interface HlsParams {
  url: string;
  headers: Record<string, string>;
  timeout: number;
  /** 已读取到的清单文本（可能只有前几 KB） */
  text?: string;
  total?: number;
  contentType?: string;
}

async function probeHls(params: HlsParams): Promise<VideoProbeResult> {
  const { url, headers, timeout } = params;
  const base = {
    streamKind: 'hls' as VideoStreamKind,
    format: 'm3u8',
    contentType: params.contentType || 'application/vnd.apple.mpegurl',
    downloadable: false,
    headers,
  };

  let text = params.text ?? '';
  let total = params.total;
  // 首轮只嗅探了前 4KB，清单可能被截断，这里补足
  if (!text || (text.length >= LIMITS.SNIFF_BYTES && total && total > text.length)) {
    const fresh = await fetchManifest(url, headers, timeout);
    if (fresh) {
      text = fresh.text;
      total = fresh.total;
    }
  }

  const playlist = text ? parseM3u8(text, url) : null;
  if (!playlist) {
    return { ...base, status: 'unplayable', note: '播放列表内容异常，不是有效的 HLS 清单' };
  }
  if (playlist.encrypted) {
    return { ...base, status: 'unplayable', note: '视频流已加密（AES-128），无法直接播放或下载' };
  }

  // 清单被截断时按比例还原总时长
  const ratio =
    total && text.length > 0 && total > text.length ? total / text.length : 1;

  if (playlist.isMaster) {
    const best = pickBestVariant(playlist.variants);
    if (!best) {
      return { ...base, status: 'unplayable', note: '主播放列表中未找到可用的清晰度' };
    }
    // 读取子列表，拿到真实时长与分片体积
    let duration: number | undefined;
    let size: number | undefined;
    const sub = await fetchManifest(best.url, headers, Math.min(timeout, 8_000));
    if (sub) {
      const subList = parseM3u8(sub.text, best.url);
      if (subList) {
        const subRatio =
          sub.total && sub.text.length > 0 && sub.total > sub.text.length
            ? sub.total / sub.text.length
            : 1;
        duration = subList.duration > 0 ? subList.duration * subRatio : undefined;
      }
    }
    // 清单的体积没有参考意义，按时长 × 码率估算真实大小
    if (duration && best.bandwidth) {
      size = Math.round((duration * best.bandwidth) / 8);
    }
    return {
      ...base,
      status: 'playable',
      fallbackUrl: best.url,
      duration,
      size,
      width: best.width,
      height: best.height,
      note: 'HLS 自适应流：可在预览中播放，暂不支持直接下载保存',
    };
  }

  if (!playlist.segments.length) {
    return { ...base, status: 'unplayable', note: '播放列表中没有可用的视频分片' };
  }

  const duration = playlist.duration > 0 ? playlist.duration * ratio : undefined;

  // 抽查首个分片：既能估算体积，也能提前发现防盗链
  let size: number | undefined;
  const first = playlist.segments[0];
  const seg = await request(first, { method: 'HEAD', headers }, Math.min(timeout, 8_000));
  if (seg && !seg.ok) {
    return {
      ...base,
      status: 'unplayable',
      duration,
      note: `视频分片无法访问（HTTP ${seg.status}），可能存在防盗链或登录限制`,
    };
  }
  const segSize = seg ? parseContentLength(seg.headers['content-length']) : undefined;
  if (segSize) size = segSize * playlist.segments.length;

  return {
    ...base,
    status: 'playable',
    duration,
    size,
    note: 'HLS 流媒体：可在预览中播放，暂不支持直接下载保存',
  };
}

/**
 * 校验单个视频资源。
 */
export async function probeVideoItem(
  item: MediaItem,
  ctx: VideoProbeContext = {},
): Promise<VideoProbeResult> {
  const timeout = ctx.timeout ?? TIMING.VIDEO_PROBE_TIMEOUT;
  const headers = requestHeaders(item.url, ctx);

  if (!/^https?:/i.test(item.url)) {
    return {
      status: 'unplayable',
      downloadable: false,
      headers,
      note: unsupportedUrlNote(item.url),
    };
  }

  const head = await request(item.url, { method: 'HEAD', headers }, timeout);
  let result: HttpResult | null = head;
  let body: Uint8Array | undefined;

  if (!head || !head.ok) {
    // HEAD 常被 CDN / WAF 直接拒绝（405/403），不能只凭它下结论，降级为 Range GET 再判定
    if (head && (head.status === 404 || head.status === 410)) {
      return {
        status: 'unplayable',
        downloadable: false,
        headers,
        note: statusNote(head.status, item.pageProbeOk),
      };
    }
    const fallback = await request(
      item.url,
      { method: 'GET', headers: { ...headers, Range: `bytes=0-${LIMITS.SNIFF_BYTES - 1}` } },
      timeout,
    );
    if (!fallback) {
      return {
        status: 'unplayable',
        downloadable: false,
        headers,
        note: head
          ? statusNote(head.status, item.pageProbeOk)
          : item.pageProbeOk
            ? '该资源在网页中可播放，但当前环境无法直接访问（可能依赖登录态或防盗链）'
            : '无法访问该资源，可能是网络异常或已被限制',
      };
    }
    if (!fallback.ok) {
      return {
        status: 'unplayable',
        downloadable: false,
        headers,
        note: statusNote(fallback.status, item.pageProbeOk),
      };
    }
    result = fallback;
    body = fallback.bytes;
  }

  if (!result) {
    return {
      status: 'unplayable',
      downloadable: false,
      headers,
      note: '无法访问该资源，可能是网络异常或已被限制',
    };
  }

  const contentType = normalizeContentType(result.headers['content-type']);
  const fileName = fileNameOf(item.url, result.headers['content-disposition']);
  let guess = detectFormat(fileName, contentType);

  // 先按 HEAD 的结果取体积，避免被 Range 响应的分片长度覆盖
  let size =
    head && head.ok
      ? parseContentRange(head.headers['content-range']) ??
        parseContentLength(head.headers['content-length'])
      : undefined;
  if (size === undefined) {
    size =
      parseContentRange(result.headers['content-range']) ??
      parseContentLength(result.headers['content-length']);
  }

  if (result === head && head) {
    const wantPlaylist =
      !!guess &&
      (HLS_FORMATS.indexOf(guess) >= 0 || guess === 'mpd');
    const ambiguous =
      !guess ||
      !contentType ||
      contentType === 'application/octet-stream' ||
      contentType === 'binary/octet-stream' ||
      contentType.indexOf('text/') === 0;
    if (wantPlaylist || ambiguous) {
      const length = parseContentLength(head.headers['content-length']);
      const ranged = acceptsRanges(head.headers['accept-ranges']);
      // 只有支持断点续传、或文件本身不大时，才放心地把内容读回来
      if (ranged || !length || length <= LIMITS.PLAYLIST_BYTES) {
        const limit = wantPlaylist ? LIMITS.PLAYLIST_BYTES : LIMITS.SNIFF_BYTES;
        const partial = await request(
          item.url,
          { method: 'GET', headers: { ...headers, Range: `bytes=0-${limit - 1}` } },
          timeout,
        );
        if (partial && partial.ok && partial.bytes) {
          result = { ...head, headers: { ...head.headers, ...partial.headers } };
          body = partial.bytes;
        }
      }
    }
  }

  if (body && body.length) {
    const sniffed = sniffFormat(body);
    if (sniffed?.markup === 'html') {
      return {
        status: 'unplayable',
        downloadable: false,
        headers,
        note: '服务器返回的是网页而不是视频（可能需要登录，或链接已过期）',
      };
    }
    if (sniffed?.format) {
      // 嗅探结果优先：Content-Type 经常是笼统的 octet-stream
      guess = sniffed.format;
    }
  }

  if (!guess) {
    if (contentType.indexOf('audio/') === 0) {
      return {
        status: 'unplayable',
        downloadable: false,
        headers,
        note: '该链接是音频文件，不是视频',
      };
    }
    if (contentType.indexOf('video/') === 0) {
      guess = formatFromContentType(contentType) ?? 'mp4';
    } else {
      return {
        status: 'unplayable',
        downloadable: false,
        headers,
        note: `无法识别该资源的视频格式（Content-Type：${contentType || '未知'}）`,
      };
    }
  }

  if (contentType.indexOf('audio/') === 0 && HLS_FORMATS.indexOf(guess) < 0 && guess !== 'mpd') {
    return {
      status: 'unplayable',
      downloadable: false,
      headers,
      format: guess,
      contentType,
      note: '该链接是音频文件，不是视频',
    };
  }

  if (HLS_FORMATS.indexOf(guess) >= 0) {
    const total =
      parseContentRange(result?.headers['content-range']) ??
      parseContentLength(result?.headers['content-length']);
    return probeHls({
      url: item.url,
      headers,
      timeout,
      text: body ? decodeText(body) : undefined,
      total,
      contentType: guess === 'm3u8' ? 'application/vnd.apple.mpegurl' : undefined,
    });
  }

  if (guess === 'mpd') {
    const dashBase = {
      streamKind: 'dash' as VideoStreamKind,
      format: 'mpd',
      contentType: 'application/dash+xml',
      downloadable: false,
      headers,
    };
    if (Platform.OS === 'ios') {
      return { ...dashBase, status: 'unplayable', note: 'DASH（.mpd）流媒体在 iOS 上无法播放' };
    }
    return {
      ...dashBase,
      status: 'playable',
      note: 'DASH 流媒体：可在预览中播放，暂不支持直接下载保存',
    };
  }

  if (!canPlayFormat(guess)) {
    return {
      status: 'unplayable',
      downloadable: false,
      headers,
      format: guess,
      contentType,
      note: `当前设备不支持 ${guess.toUpperCase()} 格式的播放`,
    };
  }

  if (size !== undefined && size < LIMITS.MIN_VIDEO_SIZE) {
    return {
      status: 'unplayable',
      downloadable: false,
      headers,
      format: guess,
      contentType,
      size,
      note: '文件过小，可能是占位图或广告素材',
    };
  }

  return {
    status: 'playable',
    streamKind: 'progressive',
    format: guess,
    contentType: contentType || undefined,
    size,
    downloadable: true,
    headers,
  };
}

function applyResult(item: MediaItem, result: VideoProbeResult) {
  item.playback = result.status;
  item.playbackNote = result.note;
  item.streamKind = result.streamKind;
  item.format = result.format;
  item.contentType = result.contentType;
  // 站点适配可能已给出备用地址（如 B 站的备源 CDN），探测结果为空时不要覆盖掉
  if (result.fallbackUrl) item.fallbackUrl = result.fallbackUrl;
  item.downloadable = result.downloadable;
  item.headers = result.headers;
  if (result.size) item.size = result.size;
  if (result.duration) item.duration = result.duration;
  if (result.width && result.height) {
    item.width = result.width;
    item.height = result.height;
  }
}

interface ProbeVideosOptions extends VideoProbeContext {
  onTick?: (done: number, total: number) => void;
  shouldStop?: () => boolean;
}

/**
 * 并发校验视频可播放性，结果直接写回 item。
 * 单个视频失败不影响整体流程，只把它标记为不可播放。
 */
export async function probeVideos(items: MediaItem[], options: ProbeVideosOptions = {}) {
  // 非 http(s) 的地址（blob:/data:）不发起请求，但仍会标记为不可播放。
  // 超过上限时优先校验页面 DOM 里的直链，网络层嗅探到的候选排在后面。
  const targets = items
    .filter(item => item.kind === 'video')
    .sort((a, b) => (a.viaNetwork ? 1 : 0) - (b.viaNetwork ? 1 : 0))
    .slice(0, TIMING.VIDEO_PROBE_MAX);

  if (!targets.length) {
    options.onTick?.(0, 0);
    return;
  }

  let done = 0;
  const queue = [...targets];
  const workerCount = Math.min(TIMING.VIDEO_PROBE_CONCURRENCY, queue.length);

  const worker = async () => {
    while (queue.length) {
      if (options.shouldStop?.()) return;
      const item = queue.shift();
      if (!item) return;
      try {
        const result = await probeVideoItem(item, {
          pageUrl: options.pageUrl,
          pageCookie: options.pageCookie,
          timeout: options.timeout,
        });
        applyResult(item, result);
      } catch {
        item.playback = 'unplayable';
        item.downloadable = false;
        item.playbackNote = '校验该资源时出错，可能无法正常播放';
      }
      done += 1;
      options.onTick?.(done, targets.length);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
