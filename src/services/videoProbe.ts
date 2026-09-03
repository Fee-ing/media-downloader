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
  /** 探测因网络受限被跳过、状态由「上游站点适配层已确认有效」推断而来 */
  probeSkipped?: boolean;
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
  } catch (error) {
    // 超时 / 网络错误 / CORS 等都会被这里吞掉，打印以便定位抓取失败原因
    console.warn('[videoProbe] 请求失败（超时/CORS/网络/DNS）：', init.method, url, error);
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
  if (!res || !res.bytes || !res.ok) {
    // 清单拉取失败：多因防盗链(403)/签名失效(404)/服务器不支持 Range
    console.warn('[videoProbe] 清单拉取失败：', url, res ? `HTTP ${res.status}` : '无响应');
    return null;
  }
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
    } else {
      console.warn('[videoProbe] 补全 m3u8 清单失败（首次抓取可能被截断或无法访问）：', url, {
        hadText: !!text,
        textLen: text.length,
      });
    }
  }

  const playlist = text ? parseM3u8(text, url) : null;
  if (!playlist) {
    console.warn('[videoProbe] m3u8 解析失败：内容不是有效 HLS 清单', url, {
      contentType: params.contentType,
      textLen: text.length,
      head: text.slice(0, 200),
    });
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
    } else {
      console.warn('[videoProbe] 主列表子清单拉取失败（变体地址可能无法直接访问）：', best.url);
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
      downloadable: true,
      note: 'HLS 自适应流：已支持下载并转封装为 MP4',
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
  if (!seg) {
    console.warn('[videoProbe] m3u8 首个分片 HEAD 请求无响应（超时/CORS/防盗链）：', first);
  } else if (!seg.ok) {
    console.warn('[videoProbe] m3u8 首个分片不可达：', first, `HTTP ${seg.status}`);
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
    downloadable: true,
    note: 'HLS 流媒体：已支持下载并转封装为 MP4',
  };
}

// ============================================================
// 容器分辨率解析（渐进式视频直链）
// ============================================================

const CONTAINER_HEAD_BYTES = 256 * 1024; // 头部读取量（覆盖绝大多数 moov 在前的 MP4）
const CONTAINER_TAIL_BYTES = 256 * 1024; // 尾部读取量（moov 未 faststart 优化时在文件尾）
const WEBM_HEAD_BYTES = 512 * 1024; // WebM/MKV 的 Tracks 通常在文件头部

function isPlausibleBoxSize(size: number): boolean {
  return size === 0 || size === 1 || (size >= 8 && size <= 0x7fffffff);
}

function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>>
    0
  );
}

function readU64(data: Uint8Array, offset: number): number {
  const hi = readU32(data, offset);
  const lo = readU32(data, offset + 4);
  if (hi > 0x1fffff) return Number.MAX_SAFE_INTEGER; // 超出 JS 安全整数范围
  return hi * 4294967296 + lo;
}

function readI32Fixed16(data: Uint8Array, offset: number): number {
  return (readU32(data, offset) | 0) / 65536;
}

function boxTypeAt(data: Uint8Array, offset: number): string {
  if (offset + 4 > data.length) return '';
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

/** 在指定区间内遍历查找所有指定类型的 box（box 边界精确对齐） */
function findBoxes(
  data: Uint8Array,
  start: number,
  end: number,
  type: string,
): Array<{ start: number; end: number }> {
  const boxes: Array<{ start: number; end: number }> = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = readU32(data, offset);
    if (!isPlausibleBoxSize(size32)) break;
    let headerSize = 8;
    let boxEnd = offset + size32;
    if (size32 === 1) {
      if (offset + 16 > end) break;
      const size64 = readU64(data, offset + 8);
      if (size64 < 16) break;
      headerSize = 16;
      boxEnd = offset + size64;
    } else if (size32 === 0) {
      boxEnd = end;
    }
    if (boxEnd > end || boxEnd <= offset) break;
    if (boxTypeAt(data, offset + 4) === type) {
      boxes.push({ start: offset + headerSize, end: boxEnd });
    }
    offset = boxEnd;
  }
  return boxes;
}

/** 在指定区间内查找第一个指定类型的 box（box 边界精确对齐） */
function findBox(
  data: Uint8Array,
  start: number,
  end: number,
  type: string,
): { start: number; end: number } | null {
  const boxes = findBoxes(data, start, end, type);
  return boxes.length ? boxes[0] : null;
}

/** 容错定位 box：数据可能从中途开始（头尾拼接/截断），扫描类型标记并校验 size */
function findBoxTolerant(
  data: Uint8Array,
  type: string,
): { start: number; end: number } | null {
  const c0 = type.charCodeAt(0);
  const c1 = type.charCodeAt(1);
  const c2 = type.charCodeAt(2);
  const c3 = type.charCodeAt(3);
  for (let i = 4; i + 4 <= data.length; i++) {
    if (data[i] !== c0 || data[i + 1] !== c1 || data[i + 2] !== c2 || data[i + 3] !== c3) {
      continue;
    }
    const size32 = readU32(data, i - 4);
    if (size32 === 1) {
      if (i + 8 <= data.length) {
        const size64 = readU64(data, i);
        if (size64 >= 16 && i - 4 + size64 <= data.length) {
          return { start: i + 8, end: i - 4 + size64 };
        }
      }
      continue;
    }
    if (size32 === 0) return { start: i + 4, end: data.length };
    if (size32 >= 8 && i - 4 + size32 <= data.length) {
      return { start: i + 4, end: i - 4 + size32 };
    }
  }
  return null;
}

/** 视频 sample entry 格式白名单（用于跳过音轨/字幕轨） */
const VIDEO_SAMPLE_ENTRY_RE =
  /^(avc1|avc2|avc3|avc4|hvc1|hev1|hvc2|vp08|vp09|av01|mp4v|encv|dvhe|dvc1|dvh1|h263|s263|mjpa|mjpb|jpeg|jpgv)$/i;

/** 从 stsd 的视频 sample entry 读取视觉尺寸（编码分辨率） */
function parseStsdVideoEntry(
  data: Uint8Array,
  start: number,
  end: number,
): { width: number; height: number } | null {
  if (end - start < 8) return null;
  const entryCount = readU32(data, start + 4);
  let offset = start + 8;
  for (let i = 0; i < entryCount && offset + 8 <= end; i++) {
    const size = readU32(data, offset);
    if (!isPlausibleBoxSize(size) || size === 1 || size === 0) break;
    if (offset + 36 <= end) {
      const format = boxTypeAt(data, offset + 4);
      if (VIDEO_SAMPLE_ENTRY_RE.test(format)) {
        // VisualSampleEntry 的宽高位于 entry 起点偏移 32 处
        const width = readU16(data, offset + 32);
        const height = readU16(data, offset + 34);
        if (width > 0 && height > 0 && width <= 16384 && height <= 16384) {
          return { width, height };
        }
      }
    }
    offset += size;
  }
  return null;
}

/** 从 tkhd 读取展示尺寸，并应用旋转（90°/270°）修正 */
function parseTkhd(
  data: Uint8Array,
  start: number,
  end: number,
): { width: number; height: number } | null {
  if (end - start < 4) return null;
  const version = data[start] & 0xff;
  const base = start + 4 + (version === 1 ? 32 : 20) + 16;
  if (base + 44 > end) return null;
  const matrix = base;
  const a = readI32Fixed16(data, matrix);
  const b = readI32Fixed16(data, matrix + 4);
  const c = readI32Fixed16(data, matrix + 8);
  const d = readI32Fixed16(data, matrix + 12);
  let width = readU32(data, base + 36) >>> 16; // 16.16 定点数取整
  let height = readU32(data, base + 40) >>> 16;
  if (
    Math.abs(a) < 0.5 &&
    Math.abs(d) < 0.5 &&
    (Math.abs(b) > 0.5 || Math.abs(c) > 0.5)
  ) {
    const tmp = width;
    width = height;
    height = tmp;
  }
  if (width > 0 && height > 0 && width <= 16384 && height <= 16384) {
    return { width, height };
  }
  return null;
}

/** 解析 ISO BMFF（MP4/MOV/M4V）容器分辨率 */
function parseIsoBmffResolution(data: Uint8Array): { width: number; height: number } | null {
  const moov = findBoxTolerant(data, 'moov');
  if (!moov) return null;
  const traks = findBoxes(data, moov.start, moov.end, 'trak');
  // 1) stsd 视频 sample entry（编码分辨率，最准确）
  for (let i = 0; i < traks.length; i++) {
    const mdia = findBox(data, traks[i].start, traks[i].end, 'mdia');
    if (!mdia) continue;
    const minf = findBox(data, mdia.start, mdia.end, 'minf');
    if (!minf) continue;
    const stbl = findBox(data, minf.start, minf.end, 'stbl');
    if (!stbl) continue;
    const stsd = findBox(data, stbl.start, stbl.end, 'stsd');
    if (!stsd) continue;
    const dim = parseStsdVideoEntry(data, stsd.start, stsd.end);
    if (dim) return dim;
  }
  // 2) tkhd 展示尺寸（含旋转修正）
  for (let i = 0; i < traks.length; i++) {
    const tkhd = findBox(data, traks[i].start, traks[i].end, 'tkhd');
    if (!tkhd) continue;
    const dim = parseTkhd(data, tkhd.start, tkhd.end);
    if (dim) return dim;
  }
  return null;
}

function readEbmlId(data: Uint8Array, offset: number): { value: number; size: number } | null {
  const first = data[offset];
  if (!first) return null;
  let len = 0;
  for (let i = 0; i < 4; i++) {
    if (first & (0x80 >> i)) {
      len = i + 1;
      break;
    }
  }
  if (!len || offset + len > data.length) return null;
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + data[offset + i];
  return { value, size: len };
}

function readEbmlSize(data: Uint8Array, offset: number): { value: number; size: number } | null {
  const first = data[offset];
  if (!first) return null;
  let len = 0;
  for (let i = 0; i < 8; i++) {
    if (first & (0x80 >> i)) {
      len = i + 1;
      break;
    }
  }
  if (!len || offset + len > data.length) return null;
  let value = first & (0x7f >> (len - 1));
  for (let i = 1; i < len; i++) {
    value = value * 256 + data[offset + i];
    if (value > 0x1fffffffffffff) break; // 超长视为 unknown size
  }
  return { value, size: len };
}

function walkEbml(
  data: Uint8Array,
  start: number,
  end: number,
  visit: (id: number, s: number, e: number) => void,
) {
  let offset = start;
  while (offset + 2 <= end) {
    const id = readEbmlId(data, offset);
    if (!id) break;
    const size = readEbmlSize(data, offset + id.size);
    if (!size) break;
    const contentStart = offset + id.size + size.size;
    if (contentStart > end) break;
    if (size.value > end - contentStart) {
      // unknown size（live 流常见）：元素延伸到数据末尾
      visit(id.value, contentStart, end);
      break;
    }
    const contentEnd = contentStart + size.value;
    visit(id.value, contentStart, contentEnd);
    offset = contentEnd;
  }
}

function readEbmlUint(data: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end && i < data.length; i++) {
    value = value * 256 + data[i];
    if (value > 0x7fffffff) break;
  }
  return value;
}

/** 容错定位 EBML 元素：数据可能从中途开始，逐步对齐边界 */
function findEbmlTolerant(
  data: Uint8Array,
  start: number,
  end: number,
  targetId: number,
): { start: number; end: number } | null {
  let offset = start;
  while (offset + 2 <= end) {
    const id = readEbmlId(data, offset);
    if (!id) break;
    const size = readEbmlSize(data, offset + id.size);
    if (!size) break;
    const contentStart = offset + id.size + size.size;
    if (contentStart > end) {
      offset += 1;
      continue;
    }
    if (id.value === targetId) {
      let contentEnd = contentStart + size.value;
      if (contentEnd > end || contentEnd < contentStart) contentEnd = end;
      return { start: contentStart, end: contentEnd };
    }
    if (size.value > end - contentStart) {
      const inner = findEbmlTolerant(data, contentStart, end, targetId);
      if (inner) return inner;
      break;
    }
    offset = contentStart + size.value;
  }
  return null;
}

/** 解析 Matroska/WebM（EBML）容器分辨率 */
function parseWebmResolution(data: Uint8Array): { width: number; height: number } | null {
  const segment = findEbmlTolerant(data, 0, data.length, 0x18538067);
  if (!segment) return null;
  const tracks = findEbmlTolerant(data, segment.start, segment.end, 0x1654ae6b);
  if (!tracks) return null;
  let result: { width: number; height: number } | null = null;
  walkEbml(data, tracks.start, tracks.end, (id, s, e) => {
    if (result || id !== 0xae) return; // TrackEntry
    let isVideo = false;
    let w = 0;
    let h = 0;
    walkEbml(data, s, e, (id2, s2, e2) => {
      if (id2 === 0x83) {
        isVideo = data[s2] === 1; // TrackType: 1 = video
      } else if (id2 === 0xe0) {
        walkEbml(data, s2, e2, (id3, s3, e3) => {
          if (id3 === 0xb0) w = readEbmlUint(data, s3, e3); // PixelWidth
          else if (id3 === 0xba) h = readEbmlUint(data, s3, e3); // PixelHeight
        });
      }
    });
    if (isVideo && w > 0 && h > 0 && w <= 16384 && h <= 16384) {
      result = { width: w, height: h };
    }
  });
  return result;
}

/** 按 Range 读取一段字节 */
async function readByteRange(
  url: string,
  headers: Record<string, string>,
  start: number,
  end: number,
  timeout: number,
): Promise<Uint8Array | null> {
  const res = await request(
    url,
    { method: 'GET', headers: { ...headers, Range: `bytes=${start}-${end}` } },
    timeout,
  );
  if (!res || !res.ok || !res.bytes || !res.bytes.length) return null;
  return res.bytes;
}

/**
 * 解析渐进式视频直链的容器分辨率（MP4 家族 / WebM / MKV）。
 * 服务器不支持 Range 或读取失败时返回 null，由调用方兜底。
 */
async function probeContainerResolution(
  url: string,
  format: string,
  headers: Record<string, string>,
  timeout: number,
  knownSize?: number,
): Promise<{ width: number; height: number } | null> {
  const isMp4Family = ['mp4', 'm4v', 'mov', 'm4s', 'f4v', '3gp', '3gp2'].indexOf(format) >= 0;
  const isMatroska = format === 'webm' || format === 'mkv';
  if (!isMp4Family && !isMatroska) return null;

  // 1) 读文件头
  const headBytes = isMatroska ? WEBM_HEAD_BYTES : CONTAINER_HEAD_BYTES;
  const head = await readByteRange(url, headers, 0, headBytes - 1, timeout);
  if (head) {
    const dim = isMatroska ? parseWebmResolution(head) : parseIsoBmffResolution(head);
    if (dim) return dim;
  }

  // 2) MP4 的 moov 常被放到文件末尾（未做 faststart 优化），补读尾部
  if (isMp4Family && knownSize && knownSize > headBytes) {
    const tailStart = Math.max(0, knownSize - CONTAINER_TAIL_BYTES);
    const tail = await readByteRange(url, headers, tailStart, knownSize - 1, timeout);
    if (tail) {
      const combined = new Uint8Array((head ? head.length : 0) + tail.length);
      if (head) combined.set(head, 0);
      combined.set(tail, head ? head.length : 0);
      const dim = parseIsoBmffResolution(combined);
      if (dim) return dim;
      const dimTail = parseIsoBmffResolution(tail);
      if (dimTail) return dimTail;
    }
  }

  return null;
}

/**
 * 上游站点适配层是否已明确确认该资源有效。
 *
 * 满足任一即视为「来源可靠，应信任」：
 * - 配对了独立伴音轨（DASH 音画分离）：站点适配层从 playinfo 等结构里明确区分了
 *   音视频轨，说明这确实是一条视频，且播放/下载时已有音轨可合并；
 * - 直接来自页面 playinfo / JSON（source==='json'）：站点专属适配层已从页面数据结构
 *   里读到的真实地址，不是模糊嗅探猜出来的。
 *
 * 这类资源即使 App 侧的 HEAD/GET 探测因自定义端口、签名直链、证书或超时失败，
 * 真实播放器（带 Referer）通常也能正常访问，因此不应直接判为「无法播放」而隐藏。
 */
function isConfirmedValidSource(item: MediaItem): boolean {
  const hasAudioPair =
    (Array.isArray(item.audioTrackUrls) && item.audioTrackUrls.length > 0) ||
    !!item.audioTrackUrl;
  return hasAudioPair || item.source === 'json';
}

/**
 * 校验单个视频资源。
 */
export async function probeVideoItem(
  item: MediaItem,
  ctx: VideoProbeContext = {},
): Promise<VideoProbeResult> {
  const timeout = ctx.timeout ?? TIMING.VIDEO_PROBE_TIMEOUT;
  // 把资源自身已记录的请求头（如提取时记录的精确 Referer）作为基础，requestHeaders
  // 不会覆盖已存在的 Referer，从而让播放器包裹页的防盗链 Referer 优先于页面地址生效。
  const headers = requestHeaders(item.url, ctx, item.headers || {});

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
    if (!head) {
      console.warn('[videoProbe] HEAD 无响应（超时/CORS/网络/证书）：', item.url);
    }
    // HEAD 常被 CDN / WAF 拒绝（405/403），很多 CDN 连 404 也是 HEAD 方法本身不被支持
    // （如 cdn.ryplay12.com：HEAD→404，但 GET / Range GET→200），不能只凭 HEAD 下结论。
    // 站点适配层已确认有效的资源（B 站 playinfo 的 DASH 直链等）可信任上游直接放行；
    // 其余情况必须真正发一次 Range GET 再判定，绝不能把 HEAD 的 404/410 当成「资源失效」而隐藏整条。
    if (head && (head.status === 404 || head.status === 410) && isConfirmedValidSource(item)) {
      return { status: 'playable', downloadable: true, headers, note: '来源已确认有效（探测受限，信任上游）', probeSkipped: true };
    }
    const fallback = await request(
      item.url,
      { method: 'GET', headers: { ...headers, Range: `bytes=0-${LIMITS.SNIFF_BYTES - 1}` } },
      timeout,
    );
    if (!fallback) {
      console.warn('[videoProbe] 降级 Range GET 无响应（资源可能依赖登录态/防盗链/签名）：', item.url);
      // 探测请求本身失败（App 网络层对自定义端口 / 签名直链常因证书或超时失败），
      // 但若上游站点适配层已明确确认这是有效资源（配对了独立音轨的 DASH 视频轨，
      // 或直接来自页面 playinfo），则信任上游、降级为可播放——真实播放器带 Referer
      // 能正常访问，不应因探测受限就把整条资源隐藏掉。
      if (isConfirmedValidSource(item)) {
        return { status: 'playable', downloadable: true, headers, note: '来源已确认有效（探测受限，信任上游）', probeSkipped: true };
      }
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
      console.warn('[videoProbe] 降级 Range GET 响应异常：', item.url, `HTTP ${fallback.status}`);
      if (isConfirmedValidSource(item)) {
        return { status: 'playable', downloadable: true, headers, note: '来源已确认有效（探测受限，信任上游）', probeSkipped: true };
      }
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
    if (isConfirmedValidSource(item)) {
      return { status: 'playable', downloadable: true, headers, note: '来源已确认有效（探测受限，信任上游）', probeSkipped: true };
    }
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
      console.warn('[videoProbe] 嗅探到 HTML（可能是错误页/登录页，并非视频）：', item.url, { contentType });
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
      console.warn('[videoProbe] 无法识别视频格式：', item.url, { contentType, fileName });
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
    // 从 MPD XML 中提取视频 Representation 的分辨率
    let width: number | undefined;
    let height: number | undefined;
    if (body && body.length) {
      const xml = decodeText(body);
      const reps = xml.match(/<Representation\b[^>]*>/g);
      if (reps) {
        for (let i = 0; i < reps.length; i++) {
          const rep = reps[i];
          // 只取视频轨：mimeType 标注 video，或完全没有 audio 标记
          if (/(mimeType="[^"]*video)/i.test(rep) || !/audio/i.test(rep)) {
            const wm = /width="(\d+)"/.exec(rep);
            const hm = /height="(\d+)"/.exec(rep);
            if (wm && hm) {
              const w = parseInt(wm[1], 10);
              const h = parseInt(hm[1], 10);
              if (w > 0 && h > 0 && w <= 16384 && h <= 16384 && (!width || !height || w * h > width * height)) {
                width = w;
                height = h;
              }
            }
          }
        }
      }
    }
    if (Platform.OS === 'ios') {
      return { ...dashBase, status: 'unplayable', note: 'DASH（.mpd）流媒体在 iOS 上无法播放' };
    }
    return {
      ...dashBase,
      status: 'playable',
      width,
      height,
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

  // 渐进式视频：DOM/JSON 采集的分辨率常缺失或为 0，解析容器头获取真实分辨率
  let width = item.width;
  let height = item.height;
  if (!width || !height) {
    const dim = await probeContainerResolution(item.url, guess, headers, timeout, size);
    if (dim) {
      width = dim.width;
      height = dim.height;
    }
  }

  return {
    status: 'playable',
    streamKind: 'progressive',
    format: guess,
    contentType: contentType || undefined,
    size,
    width,
    height,
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
  // 页面脚本可能已给出备用地址，探测结果为空时不要覆盖掉
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
  // 顺序直接沿用调用方给出的：scrapeMedia 已按置信度排好序，
  // 超过上限时截断的就是最不可能是正片的那些，这里不要再重排。
  const targets = items
    .filter(item => item.kind === 'video')
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
      } catch (error) {
        console.warn('[videoProbe] 探测过程抛出异常：', item.url, error);
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
