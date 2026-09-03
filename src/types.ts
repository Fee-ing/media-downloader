import type { SiteDebug } from './services/sites/types';

export type MediaKind = 'image' | 'video';

/** 视频可播放性校验结果：正常 / 已修复可用 / 无法播放 */
export type VideoPlaybackStatus = 'playable' | 'repaired' | 'unplayable';

/** 视频的传输形态 */
export type VideoStreamKind = 'hls' | 'dash' | 'progressive' | 'unknown';

export interface MediaItem {
  id: string;
  kind: MediaKind;
  /** 资源直链（已解析为绝对地址） */
  url: string;
  /** 标题：alt / title / 文件名 */
  title: string;
  width?: number;
  height?: number;
  /** 文件体积（字节） */
  size?: number;
  /** 视频时长（秒） */
  duration?: number;
  /** 视频封面 */
  poster?: string;
  /** 来源标记，便于调试 */
  source?: string;

  /** 可播放性校验结果（仅视频） */
  playback?: VideoPlaybackStatus;
  /** 不可播放 / 需要注意的原因说明 */
  playbackNote?: string;
  /** 传输形态：HLS / DASH / 渐进式下载 */
  streamKind?: VideoStreamKind;
  /** 容器格式：mp4 / m3u8 / webm … */
  format?: string;
  /** 实际响应头中的 Content-Type */
  contentType?: string;
  /** 主播放列表解析出的最佳清晰度地址，作为播放失败时的兜底 */
  fallbackUrl?: string;
  /** 同组 DASH 轨道数量（含音轨与备用码率），>1 表示已合并的多轨资源 */
  trackCount?: number;
  /** 独立音轨地址（DASH 伴音轨，合并后收纳，不再单独展示） */
  audioTrackUrl?: string;
  /** 全部伴音轨地址（多音轨场景按序兜底，首条与 audioTrackUrl 一致） */
  audioTrackUrls?: string[];
  /** 同组其余轨道地址（低码率视频轨等），播放失败时按序兜底 */
  variantUrls?: string[];
  /**
   * 站点适配层声明的「同一视频的多清晰度」分组（如 B 站 = bvid + cid）。
   *
   * 打了这个标记的条目不会被通用折叠逻辑压成一条：每一档清晰度各自保留为
   * 独立条目供用户选择，同档位的不同 CDN 镜像仍然合并。
   * 详见 services/sites/types.ts 的契约说明。
   */
  variantGroup?: string;
  /** 站点自己的清晰度档位号（B 站 qn：16=360P、80=1080P、116=1080P60 …） */
  qualityId?: number;
  /** 人类可读的清晰度标签（1080P60 / 4K …），由站点适配层给出 */
  qualityLabel?: string;
  /**
   * 页面脚本的站点适配层显式声明的伴音轨（如 B 站 playinfo 的 dash.audio）。
   * 仅用于音视频轨判定，不对外展示；DASH 音轨多为 .m4s，靠 URL / Content-Type
   * 判不出来，只能靠站点自身的数据结构确认。
   */
  declaredAudio?: boolean;
  /** 是否可以直接下载保存（HLS/DASH 需合并分片，暂不支持） */
  downloadable?: boolean;
  /** 下载/播放时需要携带的请求头（Referer、Cookie 等） */
  headers?: Record<string, string>;
  /**
   * 精确防盗链 Referer：当资源是从「播放器包裹页」(如 ?url=<m3u8>) 里抠出来时，
   * 原生播放器正是在那个包裹页上发请求，CDN 校验的 Referer 就是它；用页面地址
   * (vod/play/...) 当 Referer 往往被拒（404/403）。有此字段时探测优先用它。
   */
  referer?: string;
  /** 由网络层嗅探发现，而非 DOM 节点 */
  viaNetwork?: boolean;
  /** 页面内 <video> 试播是否成功（用于判断是否为登录态/防盗链资源） */
  pageProbeOk?: boolean;
}

export type SortField = 'size' | 'dimension' | 'duration' | 'title';
export type SortOrder = 'asc' | 'desc';

export interface FilterState {
  keyword: string;
  sortField: SortField;
  sortOrder: SortOrder;
}

export const DEFAULT_FILTER: FilterState = {
  keyword: '',
  sortField: 'dimension',
  sortOrder: 'desc',
};

export type ScrapePhase =
  | 'idle'
  | 'opening'
  | 'waiting'
  | 'extracting'
  | 'probing'
  | 'done'
  | 'error';

export interface ScrapeProgress {
  phase: ScrapePhase;
  message: string;
  /** 0 ~ 1，未确定时为 undefined */
  ratio?: number;
  /** 是否为超时兜底后的结果 */
  degraded?: boolean;
}

/** WebView 注入脚本返回的原始结构 */
export interface RawScrapePayload {
  title?: string;
  /** 页面地址（可能与输入地址不同，存在跳转） */
  pageUrl?: string;
  /** 页面 Cookie，仅会用于同源资源的下载与播放 */
  cookie?: string;
  /** 页面是否通过 MSE 播放（blob: 源） */
  mse?: boolean;
  /** MSE 注册过的 codec（如 video/mp4;codecs="avc1.64001f"），用于诊断 */
  mseMimes?: string[];
  /** 使用 blob: 源、拿不到直链的视频数量 */
  blobVideos?: number;
  /** srcObject（MediaStream / WebRTC）视频数量 */
  streamVideos?: number;
  /** 网络层捕获到的媒体请求数 */
  networkCount?: number;
  /**
   * 站点适配层显式声明的伴音轨地址（如 B 站 playinfo 的 dash.audio[].baseUrl）。
   * 与具体站点无关：任何适配层只要能区分音视频轨，就把音轨地址放这里，RN 侧会
   * 据此标记同轨的 CDN 镜像为伴音轨，避免音轨被当成视频轨选成代表条目。
   */
  audioUrls?: string[];
  /**
   * 站点适配层的诊断信息，按站点 id 归档。
   *
   * 用于定位「清晰度上不去 / 没有声音 / 只抓到 m4s」这类站点特有问题：
   * 播放信息从哪来的、有没有退化到网络层嗅探、站点是否登录、拿到了几档清晰度。
   */
  siteDebug?: Record<string, SiteDebug> | null;
  images: Array<{
    url: string;
    w?: number;
    h?: number;
    title?: string;
    size?: number;
    source?: string;
  }>;
  videos: Array<{
    url: string;
    poster?: string;
    w?: number;
    h?: number;
    duration?: number;
    title?: string;
    size?: number;
    source?: string;
    /** 网络层捕获到的响应类型 */
    contentType?: string;
    /** 备用 CDN 直链，主地址失效时兜底 */
    fallbackUrl?: string;
    /** 下载/播放时需要携带的请求头（Referer 等防盗链） */
    headers?: Record<string, string>;
    /** 由网络层请求捕获（非 DOM 节点） */
    viaNetwork?: boolean;
    /**
     * 请求发起者：video / audio / fetch / xmlhttprequest。
     * 来自 Resource Timing 的 initiatorType，是无扩展名直链最硬的证据。
     */
    initiator?: string;
    /** 页面内 <video> 试播是否成功 */
    probeOk?: boolean;
    /** 页面脚本给出的置信度（RN 侧会重算，主要用于页面内的探测排序） */
    score?: number;
    /**
     * 页面脚本显式标注的伴随音轨地址（DASH 音画分离场景）。
     * 站点适配层（如 B 站）已明确区分音视频轨时使用，优先级高于通用层
     * 靠 URL/Content-Type 模糊识别的 looksAudio，避免音频轨被误判为视频轨。
     */
    audioTrackUrl?: string;
    /** 全部伴随音轨地址（多码率音轨按优劣排序），首条与 audioTrackUrl 一致 */
    audioTrackUrls?: string[];
    /**
     * 站点适配层声明的「同一视频的多清晰度」分组。
     * 打了标记的候选会按清晰度档位各自保留为独立条目，不被折叠成一条。
     */
    variantGroup?: string;
    /** 站点自己的清晰度档位号（B 站 qn） */
    qualityId?: number;
    /** 人类可读的清晰度标签（1080P60 / 4K …） */
    qualityLabel?: string;
  }>;
}

export interface DownloadSnapshot {
  total: number;
  index: number;
  currentTitle: string;
  /** 当前文件进度 0 ~ 1 */
  progress: number;
  success: number;
  failed: number;
  /** 成功文件的落地方式统计 */
  saved?: { gallery: number; shared: number; file: number; cancelled: number };
  stage: 'downloading' | 'saving' | 'finished' | 'cancelled';
}
