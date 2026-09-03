/**
 * 站点适配层注册表。
 *
 * 新增站点只需两步，通用链路一行都不用改：
 *   1. 在 sites/ 下加一个适配器（页面脚本 + match + 可选 note）；
 *   2. 把它加进下面的 SITE_ADAPTERS。
 */

import { bilibiliAdapter } from './bilibili';
import type { SiteAdapter, SiteDebug } from './types';

export type { SiteAdapter, SiteDebug };

export const SITE_ADAPTERS: SiteAdapter[] = [bilibiliAdapter];

/** 全部站点脚本拼成一段，随通用脚本一起注入页面 */
export function siteSnippet(): string {
  return SITE_ADAPTERS.map(adapter => adapter.snippet).join('\n');
}

/** 命中的站点适配器（未命中返回 undefined） */
export function matchSite(url: string): SiteAdapter | undefined {
  return SITE_ADAPTERS.find(adapter => adapter.match(url));
}

/**
 * 站点给出的用户提示。
 *
 * 只解释站点特有的限制（登录态、清晰度上限、是否退化到网络层嗅探），
 * 由调用方决定展示方式。
 */
export function siteNotices(debug?: Record<string, SiteDebug> | null): string[] {
  if (!debug) return [];
  const notes: string[] = [];
  SITE_ADAPTERS.forEach(adapter => {
    const entry = debug[adapter.id];
    if (!entry || !entry.matched) return;
    const note = adapter.note?.(entry);
    if (note) notes.push(note);
  });
  return notes;
}
