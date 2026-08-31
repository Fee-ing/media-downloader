import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../constants';
import type { DownloadSnapshot } from '../types';

interface Props {
  snapshot: DownloadSnapshot | null;
  onCancel: () => void;
  onClose: () => void;
}

export default function DownloadOverlay({ snapshot, onCancel, onClose }: Props) {
  if (!snapshot) return null;
  const finished = snapshot.stage === 'finished' || snapshot.stage === 'cancelled';
  const percent = Math.round(snapshot.progress * 100);
  const saved = snapshot.saved;
  const savedSummary = saved
    ? [
        saved.gallery > 0 ? `已存入相册 ${saved.gallery} 个` : '',
        saved.shared > 0 ? `通过系统分享保存 ${saved.shared} 个` : '',
        saved.file > 0 ? `仅存于应用目录 ${saved.file} 个（相册模块不可用）` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  return (
    <Modal visible transparent animationType="fade">
      <View style={styles.mask}>
        <View style={styles.card}>
          {finished ? (
            <>
              <Ionicons
                name={snapshot.failed > 0 ? 'warning-outline' : 'checkmark-circle'}
                size={34}
                color={snapshot.failed > 0 ? COLORS.warning : COLORS.success}
              />
              <Text style={styles.title}>
                {snapshot.stage === 'cancelled' ? '下载已取消' : '下载完成'}
              </Text>
              <Text style={styles.message}>
                {`成功 ${snapshot.success} 个${snapshot.failed > 0 ? `，失败 ${snapshot.failed} 个` : ''}`}
                {savedSummary ? `\n${savedSummary}` : ''}
                {snapshot.failed > 0 ? '\n失败多为资源需要登录或防盗链' : ''}
              </Text>
              <Pressable style={styles.primary} onPress={onClose}>
                <Text style={styles.primaryText}>好的</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.title}>
                正在下载 {snapshot.index}/{snapshot.total}
              </Text>
              <Text style={styles.file} numberOfLines={2}>
                {snapshot.currentTitle || '准备中…'}
              </Text>
              <View style={styles.track}>
                <View style={[styles.bar, { width: `${Math.max(3, percent)}%` }]} />
              </View>
              <Text style={styles.percent}>
                {snapshot.stage === 'saving' ? '正在保存到相册…' : `${percent}%`}
              </Text>
              <Pressable style={styles.ghost} onPress={onCancel}>
                <Text style={styles.ghostText}>取消下载</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  card: {
    width: '100%',
    backgroundColor: COLORS.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 22,
    alignItems: 'center',
  },
  title: {
    marginTop: 12,
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  file: {
    marginTop: 8,
    color: COLORS.sub,
    fontSize: 13,
    textAlign: 'center',
  },
  message: {
    marginTop: 8,
    color: COLORS.sub,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
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
    backgroundColor: COLORS.primary,
  },
  percent: {
    marginTop: 8,
    color: COLORS.sub2,
    fontSize: 12,
  },
  ghost: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  ghostText: {
    color: COLORS.sub,
    fontSize: 13,
  },
  primary: {
    marginTop: 18,
    width: '100%',
    height: 44,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
