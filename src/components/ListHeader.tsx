import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../constants';
import type { FilterState, MediaKind } from '../types';

const SORT_LABEL: Record<string, string> = {
  default: '默认排序',
  size: '按大小',
  dimension: '按尺寸',
  duration: '按时长',
  title: '按标题',
};

interface Props {
  activeTab: MediaKind;
  imageCount: number;
  videoCount: number;
  onTabChange: (tab: MediaKind) => void;
  selectionMode: boolean;
  onToggleSelection: () => void;
  onOpenFilter: () => void;
  filter: FilterState;
  onClearFilter: () => void;
  /** 被折叠的「无法播放」资源数量 */
  hiddenUnplayable?: number;
  showUnplayable?: boolean;
  onToggleUnplayable?: () => void;
}

export default function ListHeader({
  activeTab,
  imageCount,
  videoCount,
  onTabChange,
  selectionMode,
  onToggleSelection,
  onOpenFilter,
  filter,
  onClearFilter,
  hiddenUnplayable = 0,
  showUnplayable = false,
  onToggleUnplayable,
}: Props) {
  const filtered =
    filter.keyword.trim().length > 0 ||
    filter.sortField !== 'dimension' ||
    filter.sortOrder !== 'desc';

  return (
    <View style={styles.wrapper}>
      <View style={styles.row}>
        <View style={styles.tabs}>
          <Pressable
            style={[styles.tab, activeTab === 'image' && styles.tabActive]}
            onPress={() => onTabChange('image')}
          >
            <Text style={[styles.tabText, activeTab === 'image' && styles.tabTextActive]}>
              图片 {imageCount}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.tab, activeTab === 'video' && styles.tabActive]}
            onPress={() => onTabChange('video')}
          >
            <Text style={[styles.tabText, activeTab === 'video' && styles.tabTextActive]}>
              视频 {videoCount}
            </Text>
          </Pressable>
        </View>

        <Pressable
          style={[styles.action, selectionMode && styles.actionActive]}
          onPress={onToggleSelection}
        >
          <Ionicons
            name={selectionMode ? 'close-outline' : 'checkbox-outline'}
            size={16}
            color={selectionMode ? '#fff' : COLORS.sub}
          />
          <Text style={[styles.actionText, selectionMode && styles.actionTextActive]}>
            {selectionMode ? '退出' : '批量'}
          </Text>
        </Pressable>

        <Pressable style={styles.action} onPress={onOpenFilter}>
          <Ionicons name="options-outline" size={16} color={COLORS.sub} />
          <Text style={styles.actionText}>筛选</Text>
        </Pressable>
      </View>

      {activeTab === 'video' && (hiddenUnplayable > 0 || showUnplayable) ? (
        <View style={styles.chipRow}>
          <Pressable style={styles.warnChip} onPress={onToggleUnplayable}>
            <Ionicons
              name={showUnplayable ? 'eye-off-outline' : 'eye-outline'}
              size={12}
              color={COLORS.warning}
            />
            <Text style={styles.warnChipText} numberOfLines={1}>
              {showUnplayable
                ? '正在显示全部资源 · 隐藏无法播放的'
                : `已隐藏 ${hiddenUnplayable} 个无法播放的资源 · 显示`}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {filtered ? (
        <View style={styles.chipRow}>
          <View style={styles.chip}>
            <Ionicons name="funnel" size={12} color={COLORS.primary} />
            <Text style={styles.chipText} numberOfLines={1}>
              {filter.keyword.trim()
                ? `“${filter.keyword.trim()}”`
                : SORT_LABEL[filter.sortField]}
              {filter.sortField !== 'dimension'
                ? ` · ${filter.sortOrder === 'asc' ? '升序' : '降序'}`
                : ''}
            </Text>
            <Pressable onPress={onClearFilter} hitSlop={6}>
              <Ionicons name="close" size={13} color={COLORS.sub} />
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tabs: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 3,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
    borderRadius: 9,
  },
  tabActive: {
    backgroundColor: COLORS.primarySoft,
  },
  tabText: {
    color: COLORS.sub,
    fontSize: 13,
    fontWeight: '600',
  },
  tabTextActive: {
    color: COLORS.primary,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  actionActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  actionText: {
    color: COLORS.sub,
    fontSize: 13,
    fontWeight: '600',
  },
  actionTextActive: {
    color: '#fff',
  },
  chipRow: {
    marginTop: 8,
    flexDirection: 'row',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    backgroundColor: COLORS.primarySoft,
  },
  chipText: {
    color: COLORS.primary,
    fontSize: 12,
    flexShrink: 1,
  },
  warnChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    backgroundColor: 'rgba(255,176,32,0.14)',
  },
  warnChipText: {
    color: COLORS.warning,
    fontSize: 12,
    flexShrink: 1,
  },
});
