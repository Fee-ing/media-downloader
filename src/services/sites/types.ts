import type { MediaItem } from '../../types';

/**
 * 特殊站点适配器的统一契约。
 *
 * 通用抓取（WebView 注入）依赖页面里的 <video> / 网络请求，
 * 遇到「用 MSE 播放分离音轨的 DASH 流」的站点就抓不到完整直链，
 * 这类站点需要走专属接口，实现本接口并注册即可。
 */

export interface SiteContext {
  /** 当前抓取的页面地址，用于 Referer 与稿件标识解析 */
  pageUrl: string;
  /** 页面的 document.cookie，用于换取登录态对应的清晰度 */
  cookie?: string;
}

export interface SiteAdapter {
  /** 站点标识，会写入 MediaItem.source 便于调试 */
  id: string;
  /** 判断当前页面是否属于该站点 */
  match(pageUrl: string): boolean;
  /**
   * 抓取该页面的视频直链。
   *
   * 抛出异常即视为适配失败，调用方会回退到通用抓取结果，不阻塞整体流程；
   * 返回空数组同样回退，因此「站点已识别但确实没有资源」也能安全降级。
   */
  fetchVideos(ctx: SiteContext): Promise<MediaItem[]>;
  /**
   * 可选：注入到 WebView 页面的采集脚本（纯 ES5 片段）。
   *
   * 有些站点的接口带签名（抖音的 a_bogus 就是），App 侧请求拿不到数据，
   * 但页面自己一定会请求——在页面里挂钩响应即可拿到 DOM 上不存在的完整信息。
   * 脚本在通用采集脚本之后执行，通过 window.__MD__ 注册采集钩子，
   * 因此这类站点可以让 fetchVideos 直接返回空数组。
   */
  pageScript?: string;
}
