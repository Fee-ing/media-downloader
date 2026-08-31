import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { COLORS } from '../constants';
import type { ScrapeProgress } from '../types';

interface Props {
  progress: ScrapeProgress;
}

export default function LoadingPanel({ progress }: Props) {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={COLORS.primary} />
      <Text style={styles.message}>{progress.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 14,
  },
  message: {
    color: COLORS.sub,
    fontSize: 13,
    textAlign: 'center',
  },
});
