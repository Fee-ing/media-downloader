/**
 * 特殊站点注册表。
 *
 * 抓取时先拿页面地址匹配注册表：
 * - 命中 → 用站点适配器抓「完整可播直链」；
 * - 未命中 → 沿用通用抓取（WebView 注入）的结果。
 *
 * 新增站点只需在 sites/ 下新增一个实现 SiteAdapter 的文件，并加进 ADAPTERS。
 */

import type { MediaItem } from '../../types';
import { bilibiliAdapter } from './bilibili';
import { douyinAdapter } from './douyin';
import { xiaohongshuAdapter } from './xiaohongshu';
import type { SiteAdapter, SiteContext } from './types';

const ADAPTERS: SiteAdapter[] = [bilibiliAdapter, douyinAdapter, xiaohongshuAdapter];

export type { SiteAdapter, SiteContext } from './types';

/**
 * 各站点注入到 WebView 页面的采集脚本，按注册顺序拼接。
 * 站点没有 pageScript 时不产生任何内容，通用抓取行为保持不变。
 */
export const SITE_PAGE_SCRIPTS: string = ADAPTERS.filter(
  adapter => !!adapter.pageScript,
)
  .map(adapter => adapter.pageScript as string)
  .join('\n');

/** 命中名单则返回对应适配器，未命中返回 null（走通用抓取） */
export function matchAdapter(pageUrl: string): SiteAdapter | null {
  if (!pageUrl) return null;
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.match(pageUrl)) return adapter;
    } catch {
      /* 匹配阶段出错视为不命中，回退通用逻辑 */
    }
  }
  return null;
}

/**
 * 站点专属抓取：命中名单时返回适配器给出的视频，未命中返回空数组。
 *
 * 适配器抛错或抓不到资源时也返回空数组，由调用方沿用通用抓取结果，
 * 任何情况下都不会中断整体流程。
 */
export async function fetchSiteVideos(ctx: SiteContext): Promise<MediaItem[]> {
  const adapter = matchAdapter(ctx.pageUrl);
  if (!adapter) return [];
  try {
    const videos = await adapter.fetchVideos(ctx);
    return Array.isArray(videos) ? videos.filter(item => !!item?.url) : [];
  } catch {
    return [];
  }
}
