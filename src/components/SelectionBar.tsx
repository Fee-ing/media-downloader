import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../constants';

interface Props {
  count: number;
  total: number;
  onToggleAll: () => void;
  onCancel: () => void;
  onDownload: () => void;
}

export default function SelectionBar({ count, total, onToggleAll, onCancel, onDownload }: Props) {
  return (
    <View style={styles.container}>
      <Pressable style={styles.textButton} onPress={onToggleAll}>
        <Ionicons
          name={count > 0 && count === total ? 'checkmark-circle' : 'ellipse-outline'}
          size={18}
          color={count > 0 && count === total ? COLORS.primary : COLORS.sub}
        />
        <Text style={styles.textButtonLabel}>
          {count > 0 && count === total ? '取消全选' : '全选'}
        </Text>
      </Pressable>

      <Text style={styles.count}>
        已选 <Text style={styles.countStrong}>{count}</Text> / {total}
      </Text>

      <Pressable style={styles.cancel} onPress={onCancel}>
        <Text style={styles.cancelText}>取消</Text>
      </Pressable>

      <Pressable
        style={[styles.download, count === 0 && styles.downloadDisabled]}
        onPress={onDownload}
        disabled={count === 0}
      >
        <Ionicons name="download-outline" size={17} color="#fff" />
        <Text style={styles.downloadText}>下载{count > 0 ? `(${count})` : ''}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    paddingBottom: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  textButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 6,
  },
  textButtonLabel: {
    color: COLORS.sub,
    fontSize: 13,
    fontWeight: '600',
  },
  count: {
    flex: 1,
    color: COLORS.sub,
    fontSize: 13,
    textAlign: 'center',
  },
  countStrong: {
    color: COLORS.text,
    fontWeight: '700',
  },
  cancel: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  cancelText: {
    color: COLORS.sub,
    fontSize: 13,
  },
  download: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    height: 40,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
  },
  downloadDisabled: {
    backgroundColor: COLORS.surface3,
  },
  downloadText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
