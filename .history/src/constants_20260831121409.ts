/** 抓取各阶段的时间配置（毫秒） */
export const TIMING = {
  /** 页面首次加载的超时兜底：超时后不再等待，直接进入解析 */
  LOAD_TIMEOUT: 20_000,
  /** 加载完成后的“静置”等待：等懒加载/异步资源继续加载 */
  SETTLE_TIMEOUT: 12_000,
  /** 静置阶段的轮询间隔 */
  SETTLE_INTERVAL: 500,
  /** 抽取脚本的整体兜底超时 */
  EXTRACT_TIMEOUT: 20_000,
  /** 单个文件大小探测超时 */
  PROBE_TIMEOUT: 8_000,
  /** 文件大小探测并发数 */
  PROBE_CONCURRENCY: 6,
  /** 最多探测的文件数量 */
  PROBE_MAX: 150,
  /** 单个视频可播放性校验的整体超时 */
  VIDEO_PROBE_TIMEOUT: 12_000,
  /** 视频可播放性校验并发数 */
  VIDEO_PROBE_CONCURRENCY: 4,
  /** 一页最多校验的视频数量 */
  VIDEO_PROBE_MAX: 40,
};

/** 列表数量上限，避免超大页面导致卡顿 */
export const LIMITS = {
  IMAGES: 300,
  VIDEOS: 100,
  /** 小于该体积的“视频”基本都是占位图/广告素材 */
  MIN_VIDEO_SIZE: 8 * 1024,
  /** 容器格式嗅探读取的字节数 */
  SNIFF_BYTES: 4_096,
  /** HLS/DASH 清单读取上限 */
  PLAYLIST_BYTES: 131_072,
};

export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const COLORS = {
  bg: '#0A0C10',
  surface: '#141922',
  surface2: '#1B2230',
  surface3: '#232B3B',
  border: '#252D3D',
  borderLight: '#333D52',
  text: '#E9EDF5',
  sub: '#8B95A9',
  sub2: '#5F6A80',
  primary: '#3D7EFF',
  primarySoft: 'rgba(61,126,255,0.16)',
  success: '#2FCB71',
  danger: '#FF5A5F',
  warning: '#FFB020',
  overlay: 'rgba(0,0,0,0.72)',
};

export const GAP = 12;
export const PAGE_PADDING = 14;
