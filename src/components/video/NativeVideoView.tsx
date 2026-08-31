import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { type VideoSource, VideoView, useVideoPlayer } from 'expo-video';

interface Props {
  uri: string;
  /** 播放请求需要携带的头（Referer / Cookie / UA） */
  headers?: Record<string, string>;
  /** 无标准扩展名的 HLS/DASH 必须显式声明，否则 iOS 无法识别 */
  contentType?: 'auto' | 'progressive' | 'hls' | 'dash';
  onReady: () => void;
  onError: (message?: string) => void;
}

/**
 * 单独拆分文件，便于上层做「按需加载 + 不可用降级」：
 * expo-video 依赖原生模块，在缺少该模块的运行环境中会在 import 阶段抛错。
 */
export default function NativeVideoView({ uri, headers, contentType, onReady, onError }: Props) {
  const videoRef = useRef<VideoView>(null);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };

  const source = useMemo(() => {
    const value: Record<string, unknown> = { uri };
    if (headers && Object.keys(headers).length > 0) value.headers = headers;
    if (contentType) value.contentType = contentType;
    return value as VideoSource;
  }, [uri, headers, contentType]);

  const player = useVideoPlayer(source);

  useEffect(() => {
    if (!player) return;
    const subscription = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'error') {
        callbacks.current.onError(error?.message);
      }
    });
    return () => subscription.remove();
  }, [player]);

  useEffect(() => {
    player?.play();
    // 注意：不要在这里 return 一个调用 player.pause() 的 cleanup。
    // useVideoPlayer 基于 useReleasingSharedObject 实现，卸载或换源时会先释放原生播放器；
    // 由于该 hook 在本 effect 之前声明，释放先于本 cleanup 执行，
    // 再调用 pause 就会抛出 "Cannot use shared object that was already released"。
    // 释放播放器本身即会停止播放并回收资源。
  }, [player]);

  return (
    <VideoView
      ref={videoRef}
      player={player}
      style={styles.video}
      contentFit="contain"
      nativeControls
      onFirstFrameRender={() => callbacks.current.onReady()}
    />
  );
}

const styles = StyleSheet.create({
  video: {
    width: '100%',
    height: '100%',
  },
});
