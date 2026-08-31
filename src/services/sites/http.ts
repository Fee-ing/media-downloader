import { DESKTOP_UA } from '../../constants';

/** 站点接口的单次请求超时 */
const API_TIMEOUT = 12_000;

/**
 * 请求站点开放接口，仅在业务码为 0 时返回 data。
 *
 * 超时 / 非 2xx / 业务码非 0 / 解析失败一律返回 null，由调用方自行降级，
 * 这样单个站点接口抖动不会影响整体抓取流程。
 */
export async function getApiData<T>(
  url: string,
  referer: string,
  cookie?: string,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* noop */
    }
  }, API_TIMEOUT);
  try {
    const headers: Record<string, string> = {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json, text/plain, */*',
      Referer: referer,
    };
    // Cookie 只回传给站点自己的接口，不外泄给第三方域
    if (cookie) headers.Cookie = cookie;

    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return null;
    const json = (await response.json()) as { code?: number; data?: T } | null;
    return json && json.code === 0 ? (json.data as T) : null;
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

/** 把站点的 http 封面等资源统一升级为 https，避免混合内容被拦截 */
export function toHttps(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/^http:\/\//i, 'https://');
}
