import { DESKTOP_UA } from '../constants';

/** 两个地址是否同源（含子域） */
export function isSameHost(a: string, b: string): boolean {
  try {
    const hostA = new URL(a).hostname.toLowerCase();
    const hostB = new URL(b).hostname.toLowerCase();
    return hostA === hostB || hostA.endsWith(`.${hostB}`) || hostB.endsWith(`.${hostA}`);
  } catch {
    return false;
  }
}

export interface RequestContext {
  /** 发起请求的页面地址，用于 Referer 与同源判定 */
  pageUrl?: string;
  /** 页面的 document.cookie */
  pageCookie?: string;
}

/**
 * 构造资源请求头。
 * 很多站点靠 Referer 做防盗链，登录态资源还需要 Cookie；
 * Cookie 只在同源（含子域）时携带，避免把站点会话泄漏给第三方域。
 */
export function requestHeaders(url: string, ctx: RequestContext = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: '*/*',
    'User-Agent': DESKTOP_UA,
  };
  if (ctx.pageUrl) headers.Referer = ctx.pageUrl;
  if (ctx.pageCookie && ctx.pageUrl && isSameHost(url, ctx.pageUrl)) {
    headers.Cookie = ctx.pageCookie;
  }
  return headers;
}
