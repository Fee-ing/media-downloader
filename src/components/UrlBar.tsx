import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../constants';

interface Props {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
}

export default function UrlBar({ value, onChangeText, onSubmit, onStop, busy }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.field}>
        <Ionicons name="link-outline" size={18} color={COLORS.sub} />
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder="输入网页地址，如 https://example.com"
          placeholderTextColor={COLORS.sub2}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="url"
          keyboardType="url"
          returnKeyType="search"
          onSubmitEditing={onSubmit}
          editable={!busy}
          selectionColor={COLORS.primary}
        />
        {value.length > 0 && !busy ? (
          <Pressable onPress={() => onChangeText('')} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={COLORS.sub2} />
          </Pressable>
        ) : null}
      </View>
      <Pressable
        style={[styles.button, busy && styles.buttonStop]}
        onPress={busy ? onStop : onSubmit}
      >
        <Ionicons
          name={busy ? 'stop-outline' : 'search-outline'}
          size={18}
          color="#fff"
        />
        <Text style={styles.buttonText}>{busy ? '停止' : '开始'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    paddingHorizontal: 12,
    height: 48,
  },
  input: {
    flex: 1,
    color: COLORS.text,
    fontSize: 15,
    paddingVertical: 0,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    paddingHorizontal: 16,
    height: 48,
    justifyContent: 'center',
  },
  buttonStop: {
    backgroundColor: COLORS.surface3,
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
