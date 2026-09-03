import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../constants';
import type { MediaItem } from '../types';
import { formatBytes, formatDuration, formatResolution } from '../utils/format';

interface Props {
  item: MediaItem;
  width: number;
  selectable: boolean;
  selected: boolean;
  onPress: () => void;
  onLongPress: () => void;
}

export default function VideoCard({
  item,
  width,
  selectable,
  selected,
  onPress,
  onLongPress,
}: Props) {
  const coverHeight = Math.round((width * 9) / 16);
  const unplayable = item.playback === 'unplayable';
  const streamLabel =
    item.streamKind === 'hls' ? 'HLS' : item.streamKind === 'dash' ? 'DASH' : '';
  // 已合并的 DASH 多轨资源：徽标展示轨道数量（清晰度/音轨/备用码率）
  const trackLabel =
    item.trackCount && item.trackCount > 1 ? `DASH · ${item.trackCount} 轨` : streamLabel;
  // 站点适配层给出的清晰度档位（1080P60 / 4K …）最有用，优先展示：
  // 同一视频的几档清晰度并列时，靠它才能分清该下哪一条
  const badgeLabel = item.qualityLabel || trackLabel;

  return (
    <Pressable
      style={[styles.card, { width }, selected && styles.cardSelected]}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <View style={[styles.cover, { height: coverHeight }]}>
        {item.poster ? (
          <Image
            source={{ uri: item.poster }}
            style={styles.image}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
          />
        ) : (
          <View style={styles.placeholder}>
            <Ionicons name="videocam-outline" size={26} color={COLORS.sub2} />
          </View>
        )}

        {unplayable ? (
          <View style={styles.unplayableMask}>
            <View style={styles.unplayableBadge}>
              <Ionicons name="alert-circle" size={12} color="#fff" />
              <Text style={styles.unplayableText}>无法播放</Text>
            </View>
          </View>
        ) : (
          <View style={styles.playBadge}>
            <Ionicons name="play" size={16} color="#fff" />
          </View>
        )}

        {badgeLabel ? (
          <View style={[styles.streamBadge, item.qualityLabel ? styles.qualityBadge : null]}>
            <Text style={styles.streamText}>{badgeLabel}</Text>
          </View>
        ) : null}

        <View style={styles.durationBadge}>
          <Text style={styles.durationText}>{formatDuration(item.duration)}</Text>
        </View>
      </View>

      <View style={styles.info}>
        <Text style={[styles.title, unplayable && styles.titleMuted]} numberOfLines={2}>
          {item.title || '未命名视频'}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.meta} numberOfLines={1}>
            {formatResolution(item.width, item.height)}
          </Text>
          <Text style={styles.dot}>·</Text>
          <Text style={styles.meta}>{formatDuration(item.duration)}</Text>
          <Text style={styles.dot}>·</Text>
          <Text style={styles.meta}>{formatBytes(item.size)}</Text>
        </View>
        {item.playbackNote ? (
          <Text style={[styles.note, unplayable ? styles.noteWarn : styles.noteInfo]} numberOfLines={2}>
            {item.playbackNote}
          </Text>
        ) : null}
      </View>

      {selectable ? (
        <View style={[styles.checkbox, selected && styles.checkboxActive]}>
          {selected ? <Ionicons name="checkmark" size={14} color="#fff" /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    overflow: 'hidden',
  },
  cardSelected: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primarySoft,
  },
  cover: {
    width: '100%',
    backgroundColor: COLORS.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface2,
  },
  playBadge: {
    position: 'absolute',
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 2,
  },
  unplayableMask: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(6,8,12,0.55)',
  },
  unplayableBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(255,90,95,0.9)',
  },
  unplayableText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  streamBadge: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  streamText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  /** 清晰度档位徽标：高亮一点，从一堆条目里一眼认出最高清那条 */
  qualityBadge: {
    backgroundColor: 'rgba(61,126,255,0.92)',
    borderColor: 'rgba(255,255,255,0.35)',
  },
  durationBadge: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  durationText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  info: {
    padding: 12,
    gap: 6,
  },
  title: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  titleMuted: {
    color: COLORS.sub,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  meta: {
    color: COLORS.sub,
    fontSize: 11,
    flexShrink: 1,
  },
  dot: {
    color: COLORS.sub2,
    fontSize: 11,
  },
  note: {
    fontSize: 11,
    lineHeight: 16,
  },
  noteWarn: {
    color: COLORS.warning,
  },
  noteInfo: {
    color: COLORS.sub2,
  },
  checkbox: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.85)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
});
