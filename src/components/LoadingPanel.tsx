import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { COLORS } from '../constants';
import type { ScrapeProgress } from '../types';

interface Props {
  progress: ScrapeProgress;
  onCancel: () => void;
}

export default function LoadingPanel({ progress, onCancel }: Props) {
  const ratio = progress.ratio ?? 0;

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.message}>{progress.message}</Text>
        <View style={styles.track}>
          <View
            style={[
              styles.bar,
              { width: `${Math.max(6, Math.min(100, Math.round(ratio * 100)))}%` },
            ]}
          />
        </View>
        <Text style={styles.hint}>
          {progress.degraded
            ? '已触发超时兜底，结果可能不完整'
            : '正在等待页面加载完成，稍等片刻'}
        </Text>
        <Pressable style={styles.cancel} onPress={onCancel}>
          <Text style={styles.cancelText}>取消抓取</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    backgroundColor: COLORS.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 28,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  message: {
    marginTop: 16,
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  track: {
    marginTop: 16,
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.surface3,
    overflow: 'hidden',
  },
  bar: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: COLORS.primary,
  },
  hint: {
    marginTop: 12,
    color: COLORS.sub2,
    fontSize: 12,
    textAlign: 'center',
  },
  cancel: {
    marginTop: 18,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
  },
  cancelText: {
    color: COLORS.sub,
    fontSize: 13,
  },
});
