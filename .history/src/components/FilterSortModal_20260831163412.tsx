import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../constants';
import type { FilterState, MediaKind, SortField, SortOrder } from '../types';

const SORT_FIELDS: Array<{ key: SortField; label: string }> = [
  { key: 'dimension', label: '尺寸' },
  { key: 'size', label: '大小' },
  { key: 'title', label: '标题' },
];

interface Props {
  visible: boolean;
  filter: FilterState;
  tab: MediaKind;
  onClose: () => void;
  onApply: (filter: FilterState) => void;
}

export default function FilterSortModal({ visible, filter, tab, onClose, onApply }: Props) {
  const [draft, setDraft] = useState<FilterState>(filter);

  useEffect(() => {
    if (visible) setDraft(filter);
  }, [visible, filter]);

  const fields = SORT_FIELDS.filter(
    field => field.key !== 'duration' || tab === 'video',
  );

  const orders: Array<{ key: SortOrder; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
    { key: 'desc', label: '降序', icon: 'arrow-down-outline' },
    { key: 'asc', label: '升序', icon: 'arrow-up-outline' },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.mask}>
        <Pressable style={styles.flex} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <Text style={styles.title}>筛选与排序</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={22} color={COLORS.sub} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionLabel}>按标题搜索</Text>
            <View style={styles.searchField}>
              <Ionicons name="search-outline" size={16} color={COLORS.sub2} />
              <TextInput
                style={styles.searchInput}
                value={draft.keyword}
                onChangeText={keyword => setDraft(prev => ({ ...prev, keyword }))}
                placeholder="输入关键词过滤标题"
                placeholderTextColor={COLORS.sub2}
                selectionColor={COLORS.primary}
                autoCapitalize="none"
              />
              {draft.keyword.length > 0 ? (
                <Pressable onPress={() => setDraft(prev => ({ ...prev, keyword: '' }))} hitSlop={6}>
                  <Ionicons name="close-circle" size={16} color={COLORS.sub2} />
                </Pressable>
              ) : null}
            </View>

            <Text style={styles.sectionLabel}>排序字段</Text>
            <View style={styles.chipRow}>
              {fields.map(field => {
                const active = draft.sortField === field.key;
                return (
                  <Pressable
                    key={field.key}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setDraft(prev => ({ ...prev, sortField: field.key }))}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {field.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.sectionLabel}>排序方式</Text>
            <View style={styles.chipRow}>
              {orders.map(order => {
                const active = draft.sortOrder === order.key;
                return (
                  <Pressable
                    key={order.key}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setDraft(prev => ({ ...prev, sortOrder: order.key }))}
                  >
                    <Ionicons
                      name={order.icon}
                      size={14}
                      color={active ? COLORS.primary : COLORS.sub}
                    />
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {order.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.footer}>
              <Pressable
                style={styles.reset}
                onPress={() => setDraft({ keyword: '', sortField: 'dimension', sortOrder: 'desc' })}
              >
                <Text style={styles.resetText}>重置</Text>
              </Pressable>
              <Pressable style={styles.apply} onPress={() => onApply(draft)}>
                <Text style={styles.applyText}>应用</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    justifyContent: 'flex-end',
  },
  flex: {
    flex: 1,
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 18,
    paddingBottom: 28,
    maxHeight: '80%',
  },
  grabber: {
    alignSelf: 'center',
    marginTop: 8,
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.borderLight,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  title: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  sectionLabel: {
    color: COLORS.sub,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 14,
    marginBottom: 8,
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.surface2,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    height: 44,
  },
  searchInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: COLORS.surface2,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chipActive: {
    backgroundColor: COLORS.primarySoft,
    borderColor: COLORS.primary,
  },
  chipText: {
    color: COLORS.sub,
    fontSize: 13,
    fontWeight: '600',
  },
  chipTextActive: {
    color: COLORS.primary,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 24,
  },
  reset: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.borderLight,
  },
  resetText: {
    color: COLORS.sub,
    fontSize: 15,
    fontWeight: '600',
  },
  apply: {
    flex: 2,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
  },
  applyText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
