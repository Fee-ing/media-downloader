import { TIMING } from '../constants';
import type { MediaItem } from '../types';
import { isSameHost, requestHeaders } from '../utils/http';

function readContentLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  if (!raw) return undefined;
  const value = parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 通过 HEAD（失败时降级为 Range 请求）获取文件体积 */
async function requestSize(
  url: string,
  ctx: { pageUrl?: string; pageCookie?: string },
  timeout: number = TIMING.PROBE_TIMEOUT,
): Promise<number | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* noop */
    }
  }, timeout);
  const headers = requestHeaders(url, ctx);

  try {
    const head = await fetch(url, { method: 'HEAD', headers, signal: controller.signal });
    const headLen = readContentLength(head.headers as unknown as Headers);
    if (headLen) return headLen;

    const partial = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-1' },
      signal: controller.signal,
    });
    const range = partial.headers.get('content-range');
    const match = range ? /\/(\d+)\s*$/.exec(range) : null;
    if (match) return parseInt(match[1], 10);
    return readContentLength(partial.headers as unknown as Headers);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    try {
      controller.abort();
    } catch {
      /* noop */
    }
  }
}

interface ProbeOptions {
  /** 页面地址，用于 Referer */
  referer?: string;
  /** 页面地址，用于同源 Cookie 判定（优先于 referer） */
  pageUrl?: string;
  pageCookie?: string;
  onTick?: (done: number, total: number) => void;
  shouldStop?: () => boolean;
}

/**
 * 并发探测媒体文件体积，结果直接写回 item.size。
 * 单个请求有超时兜底，失败时保持 undefined，不阻塞整体流程。
 */
export async function probeSizes(items: MediaItem[], options: ProbeOptions = {}) {
  const targets = items
    .filter(item => !item.size && /^https?:/i.test(item.url))
    .slice(0, TIMING.PROBE_MAX);

  if (!targets.length) {
    options.onTick?.(0, 0);
    return;
  }

  const pageUrl = options.pageUrl ?? options.referer;
  const cookieHost = options.pageUrl;

  let done = 0;
  const queue = [...targets];
  const workerCount = Math.min(TIMING.PROBE_CONCURRENCY, queue.length);

  const worker = async () => {
    while (queue.length) {
      if (options.shouldStop?.()) return;
      const item = queue.shift();
      if (!item) return;
      const ctx = {
        pageUrl,
        // Cookie 只在同源时携带
        pageCookie:
          options.pageCookie && cookieHost && isSameHost(item.url, cookieHost)
            ? options.pageCookie
            : undefined,
      };
      const size = await requestSize(item.url, ctx);
      if (size) item.size = size;
      done += 1;
      options.onTick?.(done, targets.length);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
