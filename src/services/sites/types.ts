/**
 * 站点适配层契约。
 *
 * 通用抓取链路（页面脚本 → scrape.ts → videoRules.ts）刻意不认识任何具体站点：
 * 候选的判定、去重、折叠、排序只认「证据」（URL 特征、响应头、initiatorType、
 * 探测结果），这样对没见过的站点也能生效。
 *
 * 但站点自己最了解自己：B 站的 DASH 音画分离、清晰度档位、登录态限制，只有从
 * 页面的数据结构里读才准确，靠通用规则猜不出来（音轨与视频轨都是 .m4s，URL 上
 * 没有任何区别）。站点适配层就是把这份「站点自己知道、通用规则猜不出」的信息，
 * 以通用契约的形式喂回主链路。
 *
 * 适配层分两半，靠一份契约对接：
 *
 *   页面侧（一段 ES5 脚本，自挂到 window.__MD__.sites[id]）
 *     watch()            页面加载即启动的后台守望，尽早把关键数据捞到手
 *     wait(timeoutMs)    采集前最后一次等待，返回 Promise<boolean>
 *     collect(addVideo)  把站点特有的资源喂进通用 adder，返回 report
 *
 *   RN 侧（SiteAdapter）
 *     match(url)         是否命中该站点
 *     snippet            注入到页面的脚本
 *     note(debug)        给用户看的补充提示（如「未登录，B 站只给 360P」）
 *
 * 主链路只认契约字段，不认站点 id —— 新增站点不需要改通用逻辑。
 *
 * 契约字段（随候选从页面侧流到 MediaItem）：
 *   variantGroup   同一视频的多清晰度/多码率分组（B 站 = bvid + cid）。
 *                  打了这个标记的候选，各清晰度会保留为独立条目，不再被
 *                  通用折叠逻辑压成一条；同档位的 CDN 镜像仍会合并。
 *   qualityId      站点自己的清晰度档位号（B 站 qn）
 *   qualityLabel   人类可读的档位名（1080P60 / 4K …）
 *   declaredAudio  站点明确声明这是伴音轨（DASH 音轨靠 URL 判不出来）
 */

/** 站点适配层回传的诊断信息（随抓取结果一起回来，用于排查与提示） */
export interface SiteDebug {
  /** 站点 id，与 SiteAdapter.id 对应 */
  id: string;
  /** 域名是否命中该站点 */
  matched?: boolean;
  /** 播放信息的来源：playinfo / initial-state / playurl / null（没拿到） */
  source?: string | null;
  /** 没能拿到站点播放信息，退化到通用网络层嗅探 */
  degraded?: boolean;
  /** 站点登录态（B 站未登录时最高只有 360P） */
  loggedIn?: boolean;
  /** 解析出的视频轨 / 伴音轨数量 */
  videoTracks?: number;
  audioTracks?: number;
  /** 拿到的最高清晰度标签 */
  topQuality?: string;
  /** 全部清晰度标签（从高到低） */
  qualities?: string[];
  error?: string;
}

export interface SiteAdapter {
  id: string;
  /** 展示名，仅用于日志与提示 */
  label: string;
  /** 页面地址是否属于该站点 */
  match(url: string): boolean;
  /** 注入到页面的 ES5 脚本片段 */
  snippet: string;
  /**
   * 给用户看的补充提示。
   *
   * 只用来解释「为什么清晰度不够 / 为什么没有声音」这类站点特有的限制，
   * 由调用方决定展示方式；返回 undefined 表示无需提示。
   */
  note?: (debug: SiteDebug) => string | undefined;
}
