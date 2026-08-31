export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '未知时长';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatDimension(width?: number, height?: number): string {
  if (width && height && width > 0 && height > 0) return `${width}×${height}`;
  return '尺寸未知';
}

/** 视频分辨率的通俗叫法，如 1920×1080 -> 1080P */
export function formatResolution(width?: number, height?: number): string {
  if (!width || !height || width <= 0 || height <= 0) return '分辨率未知';
  const shortSide = Math.min(width, height);
  const names: Record<number, string> = {
    144: '144P',
    240: '240P',
    360: '360P',
    480: '480P',
    540: '540P',
    720: '720P HD',
    1080: '1080P FHD',
    1440: '2K',
    2160: '4K',
    4320: '8K',
  };
  const label = names[shortSide];
  return label ? `${width}×${height} · ${label}` : `${width}×${height}`;
}

export function formatCount(n: number): string {
  return n > 999 ? '999+' : String(n);
}
