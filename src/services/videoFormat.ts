/**
 * 视频资源识别规则。
 *
 * 移植自 refer/fetch（FetchV 扩展）service-worker.js 中 onResponseStarted 的判定逻辑：
 * 1. 用 Content-Disposition / URL 文件名 与 Content-Type 交叉校验出容器格式；
 *    - `master.txt` + `text/plain` 视为 HLS 主列表（站点常见伪装）；
 *    - `application/octet-stream` 必须带已知视频扩展名才认定为视频；
 *    - 扩展名与 Content-Type 冲突时以 Content-Type 为准。
 * 2. 两者都无法判定时，回退到文件头字节嗅探；
 *    - 文本以 `#EXTM3U` 开头即为 HLS（对应扩展里的 CHECK_TEXT_CONTENT 二次确认）；
 *    - 其余按 ISO BMFF / Matroska / TS / FLV / Ogg / ASF 等魔数判断。
 */

/** Content-Type（规范化后）→ 可能的容器扩展名，按优先级排列 */
const CONTENT_TYPE_FORMATS: Record<string, string[]> = {
  'application/vnd.apple.mpegurl': ['m3u8', 'm3u'],
  'application/x-mpegurl': ['m3u8', 'm3u'],
  'audio/mpegurl': ['m3u8', 'm3u'],
  'audio/x-mpegurl': ['m3u8', 'm3u'],
  'application/dash+xml': ['mpd'],
  'video/mp2t': ['ts'],
  'video/mp4': ['mp4', 'm4v', 'm4s'],
  'video/3gpp': ['3gp'],
  'video/3gpp2': ['3gp2'],
  'video/x-flv': ['flv'],
  'video/quicktime': ['mov'],
  'video/x-msvideo': ['avi'],
  'video/x-ms-wmv': ['wmv'],
  'video/x-ms-asf': ['wmv', 'asf'],
  'video/webm': ['webm'],
  'video/ogg': ['ogg', 'ogv'],
  'video/x-f4v': ['f4v'],
  'video/x-matroska': ['mkv'],
  'video/iso.segment': ['m4s'],
  'video/mpeg': ['mpg'],
  'application/vnd.rn-realmedia-vbr': ['rmvb'],
  'application/vnd.americandynamics.acc': ['acc'],
  'audio/mpeg': ['mp3'],
  'audio/wav': ['wav'],
  'audio/ogg': ['ogg'],
};

/** 流式二进制：只有同时带已知扩展名才认定 */
const STREAM_CONTENT_TYPES = ['application/octet-stream', 'binary/octet-stream'];

const STREAM_EXTS = [
  'm3u8', 'm3u', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi',
  'ogg', 'ogv', 'flv', '3gp', 'wmv', 'ts', 'mp3',
];

export const VIDEO_EXTS = [
  'm3u8', 'm3u', 'mpd', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi',
  'ogg', 'ogv', 'flv', 'wmv', '3gp', '3gp2', 'm4s', 'ts', 'f4v',
  'mp3', 'wav', 'acc', 'rmvb', 'mpg',
];

/** 可拼接成单个文件下载的容器（HLS/DASH 需要合并分片，不在其中） */
export const HLS_FORMATS = ['m3u8', 'm3u'];

/** 取文件名的扩展名，不含点 */
export function extOfName(name: string): string {
  const clean = (name || '').split(/[?#]/)[0];
  const match = /\.([a-zA-Z0-9]{2,5})$/.exec(clean);
  return match ? match[1].toLowerCase() : '';
}

/** 取 Content-Type 的主类型：`video/mp4; codecs=...` → `video/mp4` */
export function normalizeContentType(value?: string | null): string {
  if (!value) return '';
  const parts = String(value).split(';');
  for (let i = 0; i < parts.length; i += 1) {
    const piece = parts[i].trim();
    if (piece) return piece.toLowerCase();
  }
  return '';
}

/** Content-Type 子类型兜底：video/* 但没有明确映射时使用 */
export function formatFromContentType(contentType: string): string | null {
  const ct = normalizeContentType(contentType);
  if (!ct.startsWith('video/')) return null;
  const sub = ct.slice('video/'.length);
  const map: Record<string, string> = {
    mp4: 'mp4', webm: 'webm', ogg: 'ogg', quicktime: 'mov', 'x-msvideo': 'avi',
    'x-ms-wmv': 'wmv', 'x-flv': 'flv', mp2t: 'ts', '3gpp': '3gp', '3gpp2': '3gp2',
    'x-matroska': 'mkv', mpeg: 'mpg', 'iso.segment': 'm4s', 'x-f4v': 'f4v',
  };
  return map[sub] ?? (sub.replace(/[^a-z0-9]/g, '') || null);
}

/**
 * 依据文件名与 Content-Type 判定容器格式，识别不出时返回 null。
 * 对应 refer/fetch 中的 `getFormat`。
 */
export function detectFormat(fileName: string, contentType?: string | null): string | null {
  const name = (fileName || '').toLowerCase();
  const ext = extOfName(name);
  const ct = normalizeContentType(contentType);

  // 站点常用 master.txt + text/plain 下发 HLS 主列表
  if (name.indexOf('master.txt') >= 0 && ct === 'text/plain') return 'm3u8';

  if (ct && CONTENT_TYPE_FORMATS[ct]) {
    const list = CONTENT_TYPE_FORMATS[ct];
    if (!ext) return list[0];
    // 扩展名与 Content-Type 冲突时以 Content-Type 为准（防盗链/伪装链接很常见）
    return list.indexOf(ext) >= 0 ? ext : list[0];
  }

  if (ct && STREAM_CONTENT_TYPES.indexOf(ct) >= 0) {
    return ext && STREAM_EXTS.indexOf(ext) >= 0 ? ext : null;
  }

  if (ext && VIDEO_EXTS.indexOf(ext) >= 0) return ext;

  return ct ? formatFromContentType(ct) : null;
}

export interface SniffResult {
  /** 识别出的容器格式 */
  format?: string;
  /** 内容是标记语言文本：html 多为错误页/登录页，xml 多为 DASH 清单 */
  markup?: 'html' | 'xml';
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  const limit = Math.min(end, bytes.length);
  for (let i = start; i < limit; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function sniffText(bytes: Uint8Array): SniffResult | null {
  const head = ascii(bytes, 0, 512).replace(/^﻿/, '').trim();
  if (!head) return null;
  if (head.indexOf('#EXTM3U') === 0) return { format: 'm3u8' };
  if (/^<\?xml/i.test(head) && /<MPD[\s>]/i.test(head)) return { format: 'mpd' };
  if (/^<MPD[\s>]/i.test(head)) return { format: 'mpd' };
  if (/^<!doctype html/i.test(head) || /^<html[\s>]/i.test(head)) return { markup: 'html' };
  if (/^<(div|p|span|a|body|head)\b/i.test(head)) return { markup: 'html' };
  if (/^<\?xml/i.test(head) || /^<[a-z]+[ >]/i.test(head)) return { markup: 'xml' };
  return null;
}

/** 依据文件头字节判断容器格式 */
export function sniffFormat(bytes: Uint8Array): SniffResult | null {
  if (!bytes || bytes.length === 0) return null;

  const text = sniffText(bytes);
  if (text) return text;

  if (bytes.length < 12) return null;

  // ISO BMFF（mp4 / mov / m4v / fMP4 分片）
  const box = ascii(bytes, 4, 8);
  if (box === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand === 'qt  ') return { format: 'mov' };
    if (brand === 'M4V ') return { format: 'm4v' };
    return { format: 'mp4' };
  }
  if (box === 'styp' || box === 'sidx' || ascii(bytes, 4, 8) === 'moof') {
    return { format: 'm4s' };
  }

  // Matroska / WebM
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { format: ascii(bytes, 0, 4096).indexOf('webm') >= 0 ? 'webm' : 'mkv' };
  }

  // MPEG-TS
  if (bytes[0] === 0x47 && (bytes[188] === 0x47 || bytes[376] === 0x47)) {
    return { format: 'ts' };
  }

  if (ascii(bytes, 0, 3) === 'FLV') return { format: 'flv' };
  if (ascii(bytes, 0, 4) === 'OggS') return { format: 'ogg' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'AVI ') return { format: 'avi' };
  if (bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2 && bytes[3] === 0x75) {
    return { format: 'wmv' };
  }
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    return { format: 'mp3' };
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && (bytes[3] === 0xba || bytes[3] === 0xb3)) {
    return { format: 'mpg' };
  }

  return null;
}

/** `bytes 0-1023/20480` → 20480 */
export function parseContentRange(value?: string | null): number | undefined {
  if (!value) return undefined;
  const head = String(value).trim().split(' ');
  if (head.length !== 2) return undefined;
  const range = head[1].split('/');
  if (range.length !== 2) return undefined;
  const total = parseInt(range[1], 10);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

export function parseContentLength(value?: string | null): number | undefined {
  if (!value) return undefined;
  const size = parseInt(String(value).trim(), 10);
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

/** 是否支持断点续传 */
export function acceptsRanges(value?: string | null): boolean {
  if (!value) return false;
  const v = String(value).toLowerCase();
  return v.indexOf('bytes') >= 0 && v.indexOf('none') < 0;
}

/** 优先取 Content-Disposition 的文件名，其次取 URL 末段 */
export function fileNameOf(url: string, contentDisposition?: string | null): string {
  if (contentDisposition) {
    const parts = String(contentDisposition).split(';');
    for (let i = 0; i < parts.length; i += 1) {
      const piece = parts[i];
      if (piece.toLowerCase().indexOf('filename=') >= 0) {
        const name = piece
          .replace(/filename\*?=/i, '')
          .replace(/^UTF-8''/i, '')
          .replace(/["']/g, '')
          .trim();
        if (name) {
          try {
            return decodeURIComponent(name);
          } catch {
            return name;
          }
        }
      }
    }
  }
  try {
    const { pathname } = new URL(url);
    const last = pathname.split('/').filter(Boolean).pop() ?? '';
    return last ? decodeURIComponent(last) : '';
  } catch {
    return '';
  }
}

export interface M3u8Variant {
  url: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
}

export interface M3u8Playlist {
  /** 主列表（含 #EXT-X-STREAM-INF） */
  isMaster: boolean;
  /** 分片被加密（#EXT-X-KEY 且 METHOD 不是 NONE） */
  encrypted: boolean;
  /** 媒体列表的总时长（秒） */
  duration: number;
  variants: M3u8Variant[];
  /** 分片地址（已解析为绝对地址） */
  segments: string[];
  hasInitMap: boolean;
  hasByteRange: boolean;
  /** 直播流：没有 #EXT-X-ENDLIST */
  live: boolean;
}

function resolveUrl(ref: string, base: string): string {
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

/** 解析 `A=1,B="2,3"` 形式的属性列表 */
function parseAttrs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9\-]+)=("[^"]*"|[^,"]*)/g;
  let match: RegExpExecArray | null = re.exec(input);
  while (match) {
    out[match[1]] = match[2].replace(/^"|"$/g, '').trim();
    match = re.exec(input);
  }
  return out;
}

function toNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 解析 HLS 播放列表 */
export function parseM3u8(text: string, baseUrl: string): M3u8Playlist | null {
  if (!text || text.indexOf('#EXTM3U') < 0) return null;

  const playlist: M3u8Playlist = {
    isMaster: false,
    encrypted: false,
    duration: 0,
    variants: [],
    segments: [],
    hasInitMap: false,
    hasByteRange: false,
    live: false,
  };

  const lines = text.split(/\r?\n/);
  let pendingStream: M3u8Variant | null = null;
  let sawEndList = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.charAt(0) === '#') {
      if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
        const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
        const resolution = attrs.RESOLUTION ? /^(\d+)x(\d+)$/i.exec(attrs.RESOLUTION) : null;
        pendingStream = {
          url: '',
          bandwidth: toNumber(attrs.BANDWIDTH) ?? toNumber(attrs['AVERAGE-BANDWIDTH']),
          width: resolution ? parseInt(resolution[1], 10) : undefined,
          height: resolution ? parseInt(resolution[2], 10) : undefined,
          codecs: attrs.CODECS ? attrs.CODECS.replace(/"/g, '') : undefined,
        };
      } else if (line.indexOf('#EXT-X-KEY:') === 0) {
        const method = (parseAttrs(line.slice('#EXT-X-KEY:'.length)).METHOD || '').toUpperCase();
        if (method && method !== 'NONE') playlist.encrypted = true;
      } else if (line.indexOf('#EXTINF:') === 0) {
        const value = /^#EXTINF:([0-9.]+)/.exec(line);
        if (value) playlist.duration += parseFloat(value[1]);
      } else if (line.indexOf('#EXT-X-MAP:') === 0) {
        playlist.hasInitMap = true;
      } else if (line.indexOf('#EXT-X-BYTERANGE:') === 0) {
        playlist.hasByteRange = true;
      } else if (line.indexOf('#EXT-X-ENDLIST') === 0) {
        sawEndList = true;
      }
      continue;
    }

    if (pendingStream) {
      pendingStream.url = resolveUrl(line, baseUrl);
      playlist.variants.push(pendingStream);
      pendingStream = null;
      continue;
    }

    playlist.segments.push(resolveUrl(line, baseUrl));
  }

  playlist.isMaster = playlist.variants.length > 0;
  playlist.live = !sawEndList && playlist.segments.length > 0;
  return playlist;
}

function hasVideoCodec(codecs?: string): boolean {
  if (!codecs) return true;
  return /avc|hvc|hev|vp0|vp9|av01|mp4v/i.test(codecs);
}

/** 主列表 → 挑选分辨率/码率最高的可用清晰度，跳过纯音轨 */
export function pickBestVariant(variants: M3u8Variant[]): M3u8Variant | null {
  if (!variants.length) return null;
  const withVideo = variants.filter(v => hasVideoCodec(v.codecs));
  const pool = withVideo.length ? withVideo : variants;
  return pool
    .slice()
    .sort(
      (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
    )[0];
}
