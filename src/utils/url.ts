const IMAGE_EXT =
  /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif|jfif|ico)(\?|#|$)/i;
const VIDEO_EXT =
  /\.(mp4|webm|ogv|ogg|mov|m4v|mkv|m3u8|mpd|flv|avi|wmv|ts)(\?|#|$)/i;

/** 规范化用户输入：补全协议、去除多余空白 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
    ? raw
    : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 取 URL 最后一段作为文件名（不含 query） */
export function fileNameFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    const last = pathname.split('/').filter(Boolean).pop() ?? '';
    const decoded = safeDecode(last);
    return decoded || 'media';
  } catch {
    return 'media';
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extFromUrl(url: string): string {
  const name = fileNameFromUrl(url);
  const match = /\.[a-zA-Z0-9]{2,5}$/.exec(name);
  return match ? match[0].toLowerCase() : '';
}

export function isImageUrl(url: string): boolean {
  return IMAGE_EXT.test(url);
}

export function isVideoUrl(url: string): boolean {
  return VIDEO_EXT.test(url);
}

export function sanitizeFileName(name: string, fallbackExt = ''): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || `media${fallbackExt}`;
}

/** 依据标题/链接生成一个带扩展名的安全文件名 */
export function buildFileName(
  url: string,
  title: string,
  fallbackExt: string,
): string {
  let ext = extFromUrl(url);
  if (!ext || ext.length > 5) ext = fallbackExt;
  const base = title && title.length > 0 ? title : fileNameFromUrl(url);
  const withoutExt = base.replace(/\.[a-zA-Z0-9]{2,5}$/, '');
  const safe = sanitizeFileName(withoutExt, ext);
  return safe.toLowerCase().endsWith(ext.toLowerCase()) ? safe : `${safe}${ext}`;
}
