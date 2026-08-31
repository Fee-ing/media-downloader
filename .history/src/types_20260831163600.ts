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
  /** 是否可以直接下载保存（HLS/DASH 需合并分片，暂不支持） */
  downloadable?: boolean;
  /** 下载/播放时需要携带的请求头（Referer、Cookie 等） */
  headers?: Record<string, string>;
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
  /** 使用 blob: 源、拿不到直链的视频数量 */
  blobVideos?: number;
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
    /** 页面内 <video> 试播是否成功 */
    probeOk?: boolean;
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
  saved?: { gallery: number; shared: number; file: number };
  stage: 'downloading' | 'saving' | 'finished' | 'cancelled';
}
