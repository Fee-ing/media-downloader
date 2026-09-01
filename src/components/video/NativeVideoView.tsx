import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { type VideoSource, VideoView, useVideoPlayer } from 'expo-video';

interface Props {
  uri: string;
  /** 全部伴音轨直链（DASH 音画分离资源）。存在时启用双播放器适配：视频轨 + 独立音轨同步播放 */
  audioUris?: string[];
  /** 兼容旧接口：单条伴音轨直链 */
  audioUri?: string;
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
 *
 * DASH 音画分离（如 B 站 m4s 视频轨 + 伴音轨）兼容适配：
 * expo-video 的 VideoSource 只支持单一源，无法像 Web 端 MSE 那样把
 * 「视频轨 URL + 音轨 URL」合成一路播放。这里改为双播放器方案：
 *  - 主播放器渲染画面（m4s 视频轨无音轨，正常情况不产生声音）；
 *  - 伴音播放器不挂 VideoView、只输出声音；
 *  - 以主播放器为时钟，伴音播放器跟随播放/暂停，并周期性校正时间漂移；
 *  - 多音轨场景按序尝试：当前伴音轨播放失败时自动切换下一条；
 *  - 全部伴音轨故障只丢声音，不阻断视频播放。
 */
export default function NativeVideoView({ uri, audioUris, audioUri, headers, contentType, onReady, onError }: Props) {
  const videoRef = useRef<VideoView>(null);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };

  const hasHeaders = !!headers && Object.keys(headers).length > 0;

  // 兼容单/多音轨两种传参，多音轨按序兜底
  const allAudioUris = useMemo(() => {
    const list = audioUris && audioUris.length ? audioUris : audioUri ? [audioUri] : [];
    return list;
  }, [audioUris, audioUri]);

  const [audioIndex, setAudioIndex] = useState(0);
  const currentAudioUri = allAudioUris.length
    ? allAudioUris[Math.min(audioIndex, allAudioUris.length - 1)]
    : undefined;

  const source = useMemo(() => {
    const value: Record<string, unknown> = { uri };
    if (hasHeaders) value.headers = headers;
    if (contentType) value.contentType = contentType;
    return value as VideoSource;
  }, [uri, headers, hasHeaders, contentType]);

  // 伴音轨源：与视频轨同一 DASH 组、音画分离的独立音轨。
  // 改版后的 B 站直链没有 .m4s 扩展名，expo-video 无法仅凭 URL 推断容器，
  // 因此必须和视频轨一样显式声明 contentType（含画面/声音同为 fragmented mp4），
  // 否则伴音轨加载失败 → 只有画面没有声音。
  const audioSource = useMemo(() => {
    if (!currentAudioUri) return null;
    const value: Record<string, unknown> = { uri: currentAudioUri };
    if (hasHeaders) value.headers = headers;
    if (contentType) value.contentType = contentType;
    return value as VideoSource;
  }, [currentAudioUri, headers, hasHeaders, contentType]);

  const player = useVideoPlayer(source);

  // 第二个播放器负责伴音轨（不挂 VideoView，只输出声音）
  const audioPlayer = useVideoPlayer(audioSource as VideoSource);

  // DASH 视频轨（m4s）本身不含音轨；若异常自带音轨则静音主播放器，避免双声道
  useEffect(() => {
    if (!player) return;
    player.muted = !!audioSource;
  }, [player, audioSource]);

  useEffect(() => {
    if (!player) return;
    const subscription = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'error') {
        callbacks.current.onError(error?.message);
      }
    });
    return () => subscription.remove();
  }, [player]);

  // 伴音轨故障：有备用音轨时自动切换下一条，全部失败则只丢声音、不阻断视频播放
  useEffect(() => {
    if (!audioPlayer || !currentAudioUri) return;
    const subscription = audioPlayer.addListener('statusChange', ({ status, error }) => {
      if (status !== 'error') return;
      if (audioIndex + 1 < allAudioUris.length) {
        console.warn('[video] 伴音轨播放失败，切换下一条音轨：', error?.message);
        setAudioIndex(audioIndex + 1);
      } else {
        console.warn('[video] 全部伴音轨播放失败，将只有画面没有声音：', error?.message);
      }
    });
    return () => subscription.remove();
  }, [audioPlayer, currentAudioUri, audioIndex, allAudioUris.length]);

  // 双播放器同步：以视频轨为时钟，伴音轨跟随播放/暂停，并周期性校正时间漂移
  useEffect(() => {
    if (!player || !audioPlayer || !audioSource) return;
    const syncToVideo = () => {
      try {
        if (audioPlayer.status !== 'readyToPlay') return;
        if (Math.abs(audioPlayer.currentTime - player.currentTime) > 0.4) {
          audioPlayer.currentTime = player.currentTime;
        }
      } catch {
        // 忽略同步中的瞬时异常
      }
    };
    const subscriptions = [
      player.addListener('playingChange', ({ isPlaying }) => {
        try {
          if (isPlaying && !audioPlayer.playing) audioPlayer.play();
          else if (!isPlaying && audioPlayer.playing) audioPlayer.pause();
        } catch {
          // 伴音轨未就绪时忽略
        }
      }),
      player.addListener('timeUpdate', syncToVideo),
      // 伴音轨就绪后立即对齐一次，避免启动阶段的无声
      audioPlayer.addListener('statusChange', ({ status }) => {
        if (status === 'readyToPlay') {
          try {
            if (Math.abs(audioPlayer.currentTime - player.currentTime) > 0.15) {
              audioPlayer.currentTime = player.currentTime;
            }
          } catch {
            // 忽略对齐中的瞬时异常
          }
        }
      }),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [player, audioPlayer, audioSource]);

  // 切换音轨后播放器会换源停住：主播放器仍在播放时，恢复伴音轨播放
  useEffect(() => {
    if (!player || !audioPlayer || !currentAudioUri) return;
    try {
      if (player.playing && audioPlayer.status === 'readyToPlay' && !audioPlayer.playing) {
        audioPlayer.play();
      }
    } catch {
      // 伴音轨尚未就绪时忽略
    }
  }, [player, audioPlayer, currentAudioUri]);

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
