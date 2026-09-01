import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../constants';
import type { MediaItem } from '../types';
import { isAudioTrackLike } from '../services/videoRules';
import { formatBytes, formatDuration, formatResolution } from '../utils/format';

const { width: SCREEN_W } = Dimensions.get('window');

type PlayerComponent = React.ComponentType<{
  uri: string;
  /** DASH 伴音轨直链，与 uri 组合播放（仅同组多轨资源）；多音轨时按序兜底 */
  audioUris?: string[];
  /** 兼容旧接口：单条伴音轨直链 */
  audioUri?: string;
  headers?: Record<string, string>;
  contentType?: 'auto' | 'progressive' | 'hls' | 'dash';
  onReady: () => void;
  onError: (message?: string) => void;
}>;

let cachedPlayer: PlayerComponent | null | undefined;

/** 按需加载播放器，环境不支持时返回 null */
function loadPlayer(): PlayerComponent | null {
  if (cachedPlayer !== undefined) return cachedPlayer;
  try {
    cachedPlayer = require('./video/NativeVideoView').default as PlayerComponent;
  } catch (error) {
    console.warn('[video] 当前运行环境不支持内嵌播放：', error);
    cachedPlayer = null;
  }
  return cachedPlayer;
}

/** 无标准扩展名的 HLS/DASH 必须显式声明 contentType，否则 iOS 无法识别 */
function contentTypeOf(item: MediaItem): 'auto' | 'progressive' | 'hls' | 'dash' {
  if (item.streamKind === 'hls') return 'hls';
  if (item.streamKind === 'dash') return 'dash';
  return 'auto';
}

interface Props {
  visible: boolean;
  item: MediaItem | null;
  downloadState: 'idle' | 'downloading' | 'done';
  downloadProgress: number;
  onClose: () => void;
  onDownload: () => void;
}

export default function VideoPlayerModal({
  visible,
  item,
  downloadState,
  downloadProgress,
  onClose,
  onDownload,
}: Props) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [chainIndex, setChainIndex] = useState(0);
  const [Player, setPlayer] = useState<PlayerComponent | null>(null);

  useEffect(() => {
    if (!visible) return;
    setReady(false);
    setFailed(null);
    setChainIndex(0);
    setPlayer(() => loadPlayer());
  }, [visible, item?.url]);

  // 播放链：主地址 → 清单解析出的最佳清晰度 → 同组备用轨道，逐个尝试。
  // 排除音频轨（URL 或 Content-Type 特征），避免播到只有声音没有画面的伴音轨。
  // 对 DASH 音画分离资源（audioTrackUrl 存在时）：主地址与同组备用视频轨都配对
  // 伴音轨，由播放器以「双播放器同步」的方式组合出声音；fallbackUrl 来自其它
  // 候选资源、时长可能不一致，不与其配对。
  const playChain = useMemo(() => {
    const chain: Array<{ uri: string; audioUris?: string[] }> = [];
    // 全部伴音轨（多音轨按序兜底）；兼容仅单个 audioTrackUrl 的旧数据
    const audioUris =
      item?.audioTrackUrls && item.audioTrackUrls.length
        ? item.audioTrackUrls
        : item?.audioTrackUrl
          ? [item.audioTrackUrl]
          : undefined;
    const grouped = (u: string) => u === item?.url || (item?.variantUrls || []).includes(u);
    const push = (u?: string) => {
      if (!u || chain.some(entry => entry.uri === u)) return;
      if (isAudioTrackLike({ url: u })) return;
      chain.push({ uri: u, audioUris: grouped(u) ? audioUris : undefined });
    };
    push(item?.url);
    push(item?.fallbackUrl);
    (item?.variantUrls || []).forEach(push);
    // 兜底：万一主地址被误判为音轨，仍保留原始地址让播放器自己尝试
    if (!chain.length && item?.url) chain.push({ uri: item.url, audioUris });
    return chain;
  }, [item?.url, item?.fallbackUrl, item?.variantUrls, item?.audioTrackUrl, item?.audioTrackUrls]);

  const blocked = item?.playback === 'unplayable';
  const playUri = playChain[Math.min(chainIndex, playChain.length - 1)]?.uri;
  const pairedAudioUris = playChain[Math.min(chainIndex, playChain.length - 1)]?.audioUris;

  const handleError = (message?: string) => {
    // 当前地址放不出来时，退回播放链中的下一个备用地址再试
    if (chainIndex + 1 < playChain.length) {
      setReady(false);
      setChainIndex(chainIndex + 1);
      return;
    }
    setFailed(message || item?.playbackNote || '该视频无法播放');
  };

  const headers = useMemo(() => item?.headers, [item?.headers]);

  if (!item || !playUri) return null;

  const downloadBlocked = item.downloadable === false;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <StatusBar style="light" />
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable style={styles.close} onPress={onClose}>
            <Ionicons name="close" size={22} color="#fff" />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {item.title}
          </Text>
        </View>

        <View style={styles.stage}>
          {blocked ? (
            <View style={styles.fallback}>
              {item.poster ? (
                <Image source={{ uri: item.poster }} style={styles.fallbackImage} contentFit="cover" />
              ) : null}
              <View style={styles.fallbackMask}>
                <Ionicons name="alert-circle-outline" size={22} color="#fff" />
                <Text style={styles.fallbackText}>
                  {item.playbackNote || '该资源无法播放'}
                </Text>
              </View>
            </View>
          ) : Player ? (
            <Player
              key={playUri}
              uri={playUri}
              audioUris={pairedAudioUris}
              headers={headers}
              contentType={contentTypeOf(item)}
              onReady={() => setReady(true)}
              onError={handleError}
            />
          ) : (
            <View style={styles.fallback}>
              {item.poster ? (
                <Image source={{ uri: item.poster }} style={styles.fallbackImage} contentFit="cover" />
              ) : null}
              <View style={styles.fallbackMask}>
                <Ionicons name="information-circle-outline" size={22} color="#fff" />
                <Text style={styles.fallbackText}>
                  当前运行环境不支持内嵌播放，可直接下载后在相册中查看
                </Text>
              </View>
            </View>
          )}

          {!blocked && Player && !ready && !failed ? (
            <View style={styles.loading}>
              <ActivityIndicator color={COLORS.primary} />
              <Text style={styles.loadingText}>视频加载中…</Text>
            </View>
          ) : null}

          {failed ? (
            <View style={styles.errorMask}>
              <Ionicons name="alert-circle-outline" size={24} color="#fff" />
              <Text style={styles.errorText}>
                {item.playbackNote || failed}
              </Text>
              <Text style={styles.errorHint}>可尝试用系统浏览器打开原网页观看</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.footer}>
          <View style={styles.metaRow}>
            <Text style={styles.meta}>{formatResolution(item.width, item.height)}</Text>
            <Text style={styles.meta}>{formatDuration(item.duration)}</Text>
            <Text style={styles.meta}>{formatBytes(item.size)}</Text>
            {item.streamKind === 'hls' ? <Text style={styles.meta}>HLS 流媒体</Text> : null}
            {item.streamKind === 'dash' ? <Text style={styles.meta}>DASH 流媒体</Text> : null}
            {item.trackCount && item.trackCount > 1 ? (
              <Text style={styles.meta}>{`DASH 多轨 · ${item.trackCount} 条轨道`}</Text>
            ) : null}
          </View>

          {item.playbackNote && !blocked ? (
            <Text style={styles.note}>{item.playbackNote}</Text>
          ) : null}

          <Pressable
            style={[
              styles.download,
              downloadState === 'downloading' && styles.downloading,
              downloadBlocked && styles.downloadDisabled,
            ]}
            onPress={onDownload}
            disabled={downloadState === 'downloading' || downloadBlocked}
          >
            <Ionicons
              name={
                downloadBlocked
                  ? 'close-circle-outline'
                  : downloadState === 'done'
                    ? 'checkmark-circle'
                    : 'download-outline'
              }
              size={18}
              color="#fff"
            />
            <Text style={styles.downloadText}>
              {downloadBlocked
                ? '该资源暂不支持下载'
                : downloadState === 'downloading'
                  ? `下载中 ${Math.round(downloadProgress * 100)}%`
                  : downloadState === 'done'
                    ? '已保存'
                    : '下载视频'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 44,
    paddingBottom: 12,
    paddingHorizontal: 14,
    gap: 10,
  },
  close: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  stage: {
    width: SCREEN_W,
    height: (SCREEN_W * 9) / 16,
    backgroundColor: '#05070B',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  loading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    color: COLORS.sub,
    fontSize: 12,
    marginTop: 6,
  },
  errorMask: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 28,
    backgroundColor: 'rgba(0,0,0,0.66)',
  },
  errorText: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  errorHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
  },
  fallback: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackImage: {
    ...StyleSheet.absoluteFill,
    width: '100%',
    height: '100%',
  },
  fallbackMask: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 28,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  fallbackText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  footer: {
    marginTop: 16,
    paddingHorizontal: 16,
    gap: 12,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  meta: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 12,
  },
  note: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    lineHeight: 18,
  },
  download: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 46,
    borderRadius: 14,
    backgroundColor: COLORS.primary,
  },
  downloading: {
    backgroundColor: COLORS.surface3,
  },
  downloadDisabled: {
    backgroundColor: COLORS.surface3,
    opacity: 0.7,
  },
  downloadText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
