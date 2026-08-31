import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../constants';
import type { MediaItem } from '../types';
import { formatBytes, formatDimension } from '../utils/format';

interface Props {
  item: MediaItem;
  width: number;
  selectable: boolean;
  selected: boolean;
  onPress: () => void;
  onLongPress: () => void;
}

export default function ImageCard({
  item,
  width,
  selectable,
  selected,
  onPress,
  onLongPress,
}: Props) {
  const coverHeight = Math.round(width * 0.72);

  return (
    <Pressable
      style={[styles.card, { width }, selected && styles.cardSelected]}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <View style={[styles.cover, { height: coverHeight }]}>
        <Image
          source={{ uri: item.url }}
          style={styles.image}
          contentFit="cover"
          transition={180}
          cachePolicy="memory-disk"
        />
      </View>

      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title || '未命名图片'}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.meta} numberOfLines={1}>
            {formatDimension(item.width, item.height)}
          </Text>
          <Text style={styles.dot}>·</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {formatBytes(item.size)}
          </Text>
        </View>
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
  },
  image: {
    width: '100%',
    height: '100%',
  },
  info: {
    padding: 10,
    gap: 6,
  },
  title: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
    minHeight: 36,
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
  checkbox: {
    position: 'absolute',
    top: 8,
    right: 8,
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
