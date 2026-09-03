import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  FlatList,
  Keyboard,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';

import EmptyState from './src/components/EmptyState';
import ImageCard from './src/components/ImageCard';
import ImageViewerModal from './src/components/ImageViewerModal';
import ListHeader from './src/components/ListHeader';
import LoadingPanel from './src/components/LoadingPanel';
import DownloadOverlay from './src/components/DownloadOverlay';
import FilterSortModal from './src/components/FilterSortModal';
import BrowserStyleWebView from './src/components/BrowserStyleWebView';
import SelectionBar from './src/components/SelectionBar';
import UrlBar from './src/components/UrlBar';
import VideoCard from './src/components/VideoCard';
import VideoPlayerModal from './src/components/VideoPlayerModal';
import { COLORS, GAP, PAGE_PADDING } from './src/constants';
import { downloadMedia, saveResultText } from './src/services/downloader';
import { filterAndSort } from './src/services/media';
import { scrapeMedia } from './src/services/scrape';
import { probeSizes } from './src/services/sizeProbe';
import { probeVideos } from './src/services/videoProbe';
import { dedupeProbedVideos } from './src/services/videoRules';
import {
  DEFAULT_FILTER,
  type DownloadSnapshot,
  type FilterState,
  type MediaItem,
  type MediaKind,
  type RawScrapePayload,
  type ScrapeProgress,
} from './src/types';
import { normalizeUrl } from './src/utils/url';

const LOADING_PHASES = ['opening', 'waiting', 'extracting'];

export default function App() {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  const [input, setInput] = useState('');
  const [taskUrl, setTaskUrl] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);
  const [progress, setProgress] = useState<ScrapeProgress>({ phase: 'idle', message: '' });
  const [images, setImages] = useState<MediaItem[]>([]);
  const [videos, setVideos] = useState<MediaItem[]>([]);
  const [pageTitle, setPageTitle] = useState('');

  const [tab, setTab] = useState<MediaKind>('image');
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER);
  const [filterVisible, setFilterVisible] = useState(false);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [previewImage, setPreviewImage] = useState<MediaItem | null>(null);
  const [previewVideo, setPreviewVideo] = useState<MediaItem | null>(null);

  const [download, setDownload] = useState<DownloadSnapshot | null>(null);
  const [singleDownload, setSingleDownload] = useState<{
    id: string;
    state: 'downloading' | 'done';
    progress: number;
  } | null>(null);

  const [probeStatus, setProbeStatus] = useState<{
    done: number;
    total: number;
    label: string;
  } | null>(null);
  const [showUnplayable, setShowUnplayable] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const probeStopRef = useRef(false);

  const busy = LOADING_PHASES.includes(progress.phase);
  const hasResult = progress.phase === 'done';
  // 标记是否已触发抓取
  const [isActive, setIsActive] = useState(false);
  // 输入框是否已固定到顶部：点击「开始」后不再回到中间，输入过程中保持原位
  const [stickyTop, setStickyTop] = useState(false);
  useEffect(() => {
    if (isActive || hasResult) setStickyTop(true);
  }, [isActive, hasResult]);
  const expanded = stickyTop;
  // 抓取成功后浏览器窗口收起（高度 → 0）
  const browserCollapsed = hasResult;

  const slideAnim = useRef(new Animated.Value(1)).current;
  const brandAnim = useRef(new Animated.Value(1)).current;
  const contentAnim = useRef(new Animated.Value(0)).current;
  const browserH = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: expanded ? 0 : 1,
        duration: 380,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(brandAnim, {
        toValue: expanded ? 0 : 1,
        duration: 260,
        useNativeDriver: false,
      }),
      Animated.timing(contentAnim, {
        toValue: expanded ? 1 : 0,
        duration: 300,
        delay: expanded ? 120 : 0,
        useNativeDriver: true,
      }),
    ]).start();
  }, [expanded, slideAnim, brandAnim, contentAnim]);

  useEffect(() => {
    Animated.timing(browserH, {
      toValue: browserCollapsed ? 0 : 1,
      duration: 340,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [browserCollapsed, browserH]);

  const idleOffset = Math.max(0, screenHeight * 0.5 - 200);
  const translateY = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, idleOffset],
  });
  const brandHeight = brandAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 108] });
  // 浏览器窗口宽度占满屏幕，按 4:3 宽高比计算高度（高 = 宽 × 3/4），同时限制不超过屏幕高度 60%
  const browserMaxHeight = browserH.interpolate({
    inputRange: [0, 1],
    outputRange: [0, Math.min(Math.round(screenWidth * (3 / 4)), Math.round(screenHeight * 0.6))],
  });

  // 默认隐藏判定为「无法播放」的资源，用户可在列表顶部切换查看
  const hiddenUnplayable = useMemo(
    () =>
      tab === 'video'
        ? videos.filter(item => item.playback === 'unplayable').length
        : 0,
    [tab, videos],
  );

  const list = useMemo(() => {
    const source = tab === 'image' ? images : videos;
    const visible =
      tab === 'video' && !showUnplayable
        ? source.filter(item => item.playback !== 'unplayable')
        : source;
    return filterAndSort(visible, filter);
  }, [tab, images, videos, filter, showUnplayable]);

  // 列表统计数字与列表实际展示一致：应用「隐藏无法播放」与筛选条件后再计数
  const imageCount = useMemo(
    () => filterAndSort(images, filter).length,
    [images, filter],
  );
  const videoCount = useMemo(() => {
    const visible = !showUnplayable
      ? videos.filter(item => item.playback !== 'unplayable')
      : videos;
    return filterAndSort(visible, filter).length;
  }, [videos, filter, showUnplayable]);

  const imageWidth = (screenWidth - PAGE_PADDING * 2 - GAP) / 2;
  const videoWidth = screenWidth - PAGE_PADDING * 2;

  const handleResult = useCallback(
    async (payload: RawScrapePayload) => {
      const pageUrl = payload.pageUrl || taskUrl || undefined;

      // 唯一的抓取入口：页面脚本的候选在这里归一、过滤、去重、排序。
      let {
        images: nextImages,
        videos: nextVideos,
        hint,
        notices,
        stats,
      } = await scrapeMedia(payload);

      // [诊断] 站点适配层：播放信息来源、清晰度档位、首条视频的音轨与防盗链头
      console.log('[SITE-DEBUG] first video:', nextVideos[0]
        ? JSON.stringify({
            url: nextVideos[0].url?.slice(0, 80),
            audioTrackUrl: nextVideos[0].audioTrackUrl ? nextVideos[0].audioTrackUrl.slice(0, 80) : null,
            audioTrackUrls: (nextVideos[0].audioTrackUrls || []).map((u: string) => u.slice(0, 80)),
            headers: nextVideos[0].headers || null,
            playback: nextVideos[0].playback,
          })
        : 'none');

      if (!nextImages.length && !nextVideos.length) {
        setProgress({
          phase: 'error',
          message: hint || '未在该页面发现可下载的图片或视频，换一个网址试试',
        });
        return;
      }

      setPageTitle(payload.title || '');
      setImages(nextImages);
      setVideos(nextVideos);
      setTab(nextImages.length > 0 ? 'image' : 'video');
      setFilter(DEFAULT_FILTER);
      setSelectionMode(false);
      setSelectedIds(new Set());
      setShowUnplayable(false);
      setProgress({ phase: 'done', message: '解析完成' });

      probeStopRef.current = false;
      const shouldStop = () => probeStopRef.current;

      // 先校验视频可播放性：提前剔除失效、防盗链、加密、格式不支持的资源
      if (nextVideos.length) {
        const label = '正在校验视频可播放性';
        setProbeStatus({ done: 0, total: nextVideos.length, label });
        await probeVideos(nextVideos, {
          pageUrl,
          pageCookie: payload.cookie,
          shouldStop,
          onTick: (done, total) =>
            setProbeStatus(total > 0 ? { done, total, label } : null),
        });
        // 探测补齐真实分辨率/时长/体积后，按内容去重：
        // 1) 分辨率+时长+体积一致的重复资源；2) 同源但元数据残缺的 .m4s 轨道。
        nextVideos = dedupeProbedVideos(nextVideos);
        setVideos(nextVideos);

        // 站点提示（未登录导致清晰度受限、退化到网络层嗅探等）只附在首条视频上，
        // 免得同一句话在每张卡片上重复出现
        if (notices?.length && nextVideos.length) {
          const note = notices.join('；');
          nextVideos = nextVideos.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  playbackNote: item.playbackNote ? `${item.playbackNote}；${note}` : note,
                }
              : item,
          );
          setVideos(nextVideos);
        }
      }

      // 再补充文件体积（已判定不可播放的视频不再浪费请求）
      const sizeTargets = [...nextImages, ...nextVideos].filter(
        item => !item.size && (item.kind === 'image' || item.playback !== 'unplayable'),
      );
      const sizeLabel = '正在获取文件大小';
      setProbeStatus({ done: 0, total: sizeTargets.length, label: sizeLabel });
      await probeSizes(sizeTargets, {
        pageUrl,
        pageCookie: payload.cookie,
        shouldStop,
        onTick: (done, total) =>
          setProbeStatus(total > 0 ? { done, total, label: sizeLabel } : null),
      });
      setProbeStatus(null);
      setImages(prev => [...prev]);
      setVideos(prev => [...prev]);
    },
    [taskUrl],
  );

  const handleError = useCallback((message: string) => {
    setProgress({ phase: 'error', message });
  }, []);

  const handleStart = () => {
    const normalized = normalizeUrl(input);
    if (!normalized) {
      Alert.alert('网址无效', '请输入正确的网页地址，例如 https://example.com');
      return;
    }
    Keyboard.dismiss();
    probeStopRef.current = true;
    setInput(normalized);
    setImages([]);
    setVideos([]);
    setPageTitle('');
    setFilter(DEFAULT_FILTER);
    setSelectionMode(false);
    setSelectedIds(new Set());
    setProbeStatus(null);
    setShowUnplayable(false);
    setProgress({ phase: 'opening', message: '正在打开网页…' });
    setIsActive(true);
    setRunId(id => id + 1);
    setTaskUrl(normalized);
  };

  const handleStop = () => {
    probeStopRef.current = true;
    abortRef.current?.abort();
    setIsActive(false);
    setTaskUrl(null);
    setProgress({ phase: 'idle', message: '' });
  };

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const enterSelection = (item: MediaItem) => {
    if (selectionMode) return;
    setSelectionMode(true);
    setSelectedIds(new Set([item.id]));
  };

  const handleCardPress = (item: MediaItem) => {
    if (selectionMode) {
      toggleSelection(item.id);
      return;
    }
    if (item.kind === 'image') setPreviewImage(item);
    else if (item.playback === 'unplayable') {
      Alert.alert('该视频无法播放', item.playbackNote || '未获取到可播放的直链');
    } else setPreviewVideo(item);
  };

  const runDownload = async (items: MediaItem[]) => {
    // HLS/DASH 等需要合并分片的资源不参与批量下载
    const queue = items.filter(item => item.downloadable !== false);
    if (!queue.length) {
      Alert.alert('无可下载资源', '所选资源均为流媒体或不可用资源，暂不支持下载保存');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    let success = 0;
    let failed = 0;
    let index = 0;
    const saved = { gallery: 0, shared: 0, file: 0, cancelled: 0 };

    const base: DownloadSnapshot = {
      total: queue.length,
      index: 0,
      currentTitle: '',
      progress: 0,
      success: 0,
      failed: 0,
      stage: 'downloading',
    };
    setDownload(base);

    for (const item of queue) {
      if (controller.signal.aborted) break;
      index += 1;
      setDownload({
        ...base,
        index,
        currentTitle: item.title,
        success,
        failed,
        stage: 'downloading',
        progress: 0,
      });
      try {
        const result = await downloadMedia(item, {
          referer: taskUrl ?? undefined,
          signal: controller.signal,
          onProgress: value =>
            setDownload(prev =>
              prev ? { ...prev, progress: value, stage: 'downloading' } : prev,
            ),
        });
        saved[result.saved] += 1;
        if (result.saved !== 'cancelled') success += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }

    const cancelled = controller.signal.aborted;
    setDownload(prev =>
      prev
        ? {
            ...prev,
            success,
            failed,
            saved,
            progress: 1,
            stage: cancelled ? 'cancelled' : 'finished',
          }
        : prev,
    );
    abortRef.current = null;
    if (!cancelled) {
      setSelectionMode(false);
      setSelectedIds(new Set());
    }
  };

  const downloadSingle = async (item: MediaItem) => {
    if (item.downloadable === false) {
      Alert.alert('暂不支持下载', item.playbackNote || '该资源为流媒体，暂不支持下载保存');
      return;
    }
    setSingleDownload({ id: item.id, state: 'downloading', progress: 0 });
    try {
      const result = await downloadMedia(item, {
        referer: taskUrl ?? undefined,
        onProgress: value =>
          setSingleDownload(prev =>
            prev && prev.id === item.id ? { ...prev, progress: value } : prev,
          ),
      });
      setSingleDownload({ id: item.id, state: 'done', progress: 1 });
      if (result.saved === 'cancelled') {
        // 用户取消分享，不计入成功，也不弹「已保存」提示
        setSingleDownload(null);
        return;
      }
      if (result.saved === 'file') {
        // 仅当真正落到应用目录时才提示（相册/分享/取消均不弹，避免误导）
        Alert.alert('已下载', `${saveResultText(result.saved)}\n${result.uri}`);
      }
    } catch {
      setSingleDownload(null);
      Alert.alert('下载失败', '该资源可能无法直接下载（通常需要登录或存在防盗链）');
    }
  };

  const selectedItems = useMemo(
    () => list.filter(item => selectedIds.has(item.id)),
    [list, selectedIds],
  );

  const renderContent = () => {
    // 未开始抓取时不展示内容区（输入框初始居中）
    if (progress.phase === 'idle') return null;

    // 抓取中且尚无数据时：展示简洁 loading
    const isLoading =
      !hasResult &&
      progress.phase !== 'error' &&
      images.length === 0 &&
      videos.length === 0;

    if (isLoading) {
      return <LoadingPanel progress={progress} />;
    }

    if (progress.phase === 'error') {
      return (
        <EmptyState
          icon="alert-circle-outline"
          title="抓取失败"
          hint={progress.message}
          actionText="重新输入"
          onAction={handleStop}
        />
      );
    }

    return (
      <View style={styles.resultWrap}>
        <ListHeader
          activeTab={tab}
          imageCount={imageCount}
          videoCount={videoCount}
          onTabChange={setTab}
          selectionMode={selectionMode}
          onToggleSelection={() => {
            setSelectionMode(prev => !prev);
            setSelectedIds(new Set());
          }}
          onOpenFilter={() => setFilterVisible(true)}
          filter={filter}
          onClearFilter={() => setFilter(DEFAULT_FILTER)}
          hiddenUnplayable={hiddenUnplayable}
          showUnplayable={showUnplayable}
          onToggleUnplayable={() => setShowUnplayable(prev => !prev)}
        />

        {probeStatus ? (
          <View style={styles.probeRow}>
            <Text style={styles.probeText}>
              {probeStatus.label} {probeStatus.done}/{probeStatus.total}
            </Text>
          </View>
        ) : null}

        {list.length === 0 ? (
          <EmptyState
            icon={
              tab === 'video' && hiddenUnplayable > 0
                ? 'alert-circle-outline'
                : tab === 'image'
                  ? 'image-outline'
                  : 'film-outline'
            }
            title={
              tab === 'video' && hiddenUnplayable > 0
                ? '没有可播放的视频'
                : tab === 'image'
                  ? '没有匹配的图片'
                  : '没有匹配的视频'
            }
            hint={
              tab === 'video' && hiddenUnplayable > 0
                ? `已找到 ${hiddenUnplayable} 个视频资源，但它们均无法播放（失效、防盗链或需要登录）。可查看全部资源了解具体原因。`
                : '试试调整筛选条件，或清除关键词后重新查看'
            }
            actionText={tab === 'video' && hiddenUnplayable > 0 ? '查看全部资源' : '清除筛选'}
            onAction={() =>
              tab === 'video' && hiddenUnplayable > 0
                ? setShowUnplayable(true)
                : setFilter(DEFAULT_FILTER)
            }
          />
        ) : (
          <FlatList
            key={tab}
            data={list}
            keyExtractor={item => item.id}
            numColumns={tab === 'image' ? 2 : 1}
            columnWrapperStyle={tab === 'image' ? styles.row : undefined}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) =>
              tab === 'image' ? (
                <ImageCard
                  item={item}
                  width={imageWidth}
                  selectable={selectionMode}
                  selected={selectedIds.has(item.id)}
                  onPress={() => handleCardPress(item)}
                  onLongPress={() => enterSelection(item)}
                />
              ) : (
                <VideoCard
                  item={item}
                  width={videoWidth}
                  selectable={selectionMode}
                  selected={selectedIds.has(item.id)}
                  onPress={() => handleCardPress(item)}
                  onLongPress={() => enterSelection(item)}
                />
              )
            }
            showsVerticalScrollIndicator={false}
          />
        )}

        {selectionMode ? (
          <SelectionBar
            count={selectedItems.length}
            total={list.length}
            onToggleAll={() => {
              if (selectedItems.length === list.length && list.length > 0) {
                setSelectedIds(new Set());
              } else {
                setSelectedIds(new Set(list.map(item => item.id)));
              }
            }}
            onCancel={() => {
              setSelectionMode(false);
              setSelectedIds(new Set());
            }}
            onDownload={() => runDownload(selectedItems)}
          />
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      {/* 顶部：初始居中，开始输入/抓取后固定在顶部 */}
      <Animated.View style={[styles.top, { transform: [{ translateY }] }]}>
        <Animated.View style={[styles.brand, { height: brandHeight, opacity: brandAnim }]}>
          <Text style={styles.brandTitle}>网页媒体抓取</Text>
          <Text style={styles.brandSub}>
            粘贴任意网页链接，自动提取页面中的图片与视频
          </Text>
        </Animated.View>

        <UrlBar
          value={input}
          onChangeText={setInput}
          onSubmit={handleStart}
          onStop={handleStop}
          busy={busy}
        />

        {hasResult && pageTitle ? (
          <Text style={styles.pageTitle} numberOfLines={1}>
            {pageTitle}
          </Text>
        ) : null}
      </Animated.View>

      {/* 浏览器窗口：位于输入框下方，抓取成功后收起（高度 → 0） */}
      {taskUrl ? (
        <Animated.View style={[styles.browserWrap, { height: browserMaxHeight }]}>
          <BrowserStyleWebView
            key={`${taskUrl}-${runId}`}
            url={taskUrl}
            onProgress={setProgress}
            onResult={handleResult}
            onError={handleError}
            onStop={handleStop}
          />
        </Animated.View>
      ) : null}

      <Animated.View style={[styles.content, { opacity: contentAnim }]}>
        {renderContent()}
      </Animated.View>

      <ImageViewerModal
        visible={previewImage !== null}
        item={previewImage}
        downloadState={
          singleDownload && previewImage && singleDownload.id === previewImage.id
            ? singleDownload.state
            : 'idle'
        }
        downloadProgress={singleDownload?.progress ?? 0}
        onClose={() => {
          setPreviewImage(null);
          setSingleDownload(null);
        }}
        onDownload={() => previewImage && downloadSingle(previewImage)}
      />

      {previewVideo ? (
        <VideoPlayerModal
          key={previewVideo.id}
          visible
          item={previewVideo}
          downloadState={
            singleDownload && singleDownload.id === previewVideo.id
              ? singleDownload.state
              : 'idle'
          }
          downloadProgress={singleDownload?.progress ?? 0}
          onClose={() => {
            setPreviewVideo(null);
            setSingleDownload(null);
          }}
          onDownload={() => previewVideo && downloadSingle(previewVideo)}
        />
      ) : null}

      <FilterSortModal
        visible={filterVisible}
        filter={filter}
        tab={tab}
        onClose={() => setFilterVisible(false)}
        onApply={next => {
          setFilter(next);
          setFilterVisible(false);
        }}
      />

      <DownloadOverlay
        snapshot={download}
        onCancel={() => abortRef.current?.abort()}
        onClose={() => {
          if (download?.stage === 'finished') setSelectionMode(false);
          setDownload(null);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  browserWrap: {
    overflow: 'hidden',
  },
  top: {
    paddingHorizontal: PAGE_PADDING,
    paddingTop: 8,
    paddingBottom: 6,
    backgroundColor: COLORS.bg,
    zIndex: 10,
  },
  brand: {
    justifyContent: 'flex-end',
    paddingBottom: 14,
    overflow: 'hidden',
  },
  brandTitle: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  brandSub: {
    marginTop: 6,
    color: COLORS.sub,
    fontSize: 13,
  },
  pageTitle: {
    marginTop: 8,
    color: COLORS.sub2,
    fontSize: 11,
  },
  content: {
    flex: 1,
  },
  resultWrap: {
    flex: 1,
  },
  row: {
    gap: GAP,
  },
  listContent: {
    paddingHorizontal: PAGE_PADDING,
    paddingBottom: 24,
    gap: GAP,
  },
  probeRow: {
    paddingHorizontal: PAGE_PADDING,
    paddingBottom: 8,
  },
  probeText: {
    color: COLORS.sub2,
    fontSize: 11,
  },
});
