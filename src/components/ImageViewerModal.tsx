import React from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../constants';
import type { MediaItem } from '../types';
import { formatBytes, formatDimension } from '../utils/format';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

interface Props {
  visible: boolean;
  item: MediaItem | null;
  downloadState: 'idle' | 'downloading' | 'done';
  downloadProgress: number;
  onClose: () => void;
  onDownload: () => void;
}

export default function ImageViewerModal({
  visible,
  item,
  downloadState,
  downloadProgress,
  onClose,
  onDownload,
}: Props) {
  if (!item) return null;

  const ratio =
    item.width && item.height && item.height > 0 ? item.width / item.height : 4 / 3;
  const boxHeight = SCREEN_H * 0.7;
  const boxWidth = Math.min(SCREEN_W, boxHeight * ratio);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <StatusBar style="light" />
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable style={styles.close} onPress={onClose}>
            <Ionicons name="close" size={22} color="#fff" />
          </Pressable>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.headerSub} numberOfLines={1}>
              {item.url}
            </Text>
          </View>
        </View>

        <ScrollView
          style={styles.zoomArea}
          contentContainerStyle={styles.zoomContent}
          maximumZoomScale={5}
          minimumZoomScale={1}
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Image
            source={{ uri: item.url }}
            style={{ width: boxWidth, height: boxHeight }}
            contentFit="contain"
            cachePolicy="memory-disk"
          />
        </ScrollView>

        <View style={styles.footer}>
          <View style={styles.metaRow}>
            <Text style={styles.meta}>{formatDimension(item.width, item.height)}</Text>
            <Text style={styles.meta}>{formatBytes(item.size)}</Text>
          </View>
          <Pressable
            style={[styles.download, downloadState === 'downloading' && styles.downloading]}
            onPress={onDownload}
            disabled={downloadState === 'downloading'}
          >
            <Ionicons
              name={downloadState === 'done' ? 'checkmark-circle' : 'download-outline'}
              size={18}
              color="#fff"
            />
            <Text style={styles.downloadText}>
              {downloadState === 'downloading'
                ? `下载中 ${Math.round(downloadProgress * 100)}%`
                : downloadState === 'done'
                  ? '已保存'
                  : '下载原图'}
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
    paddingBottom: 10,
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
  headerText: {
    flex: 1,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  headerSub: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    marginTop: 2,
  },
  zoomArea: {
    flex: 1,
  },
  zoomContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 34,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
  metaRow: {
    flexDirection: 'row',
    gap: 14,
  },
  meta: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 12,
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
  downloadText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
