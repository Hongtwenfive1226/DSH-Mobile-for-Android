// ErrorBoundary.tsx — 捕获子树渲染异常，避免整屏白屏
//
// React Native 在 release 包里没有红屏：渲染期一个未捕获异常就会卸载整棵树，
// 表现就是「全白、点不动」。这里把异常兜住并显示出来（含堆栈），
// 让问题可诊断、其余界面继续可用。

import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  children: React.ReactNode;
  /** 显示在错误面板顶部的场景名，便于快速定位是哪一块坏了 */
  label?: string;
  /** 提供时显示「重试」按钮（通常用于可重新加载的区域） */
  onRetry?: () => void;
}

interface State {
  error: Error | null;
  info: string | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    this.setState({ error, info: info?.componentStack ?? null });
    // 方便用 logcat 抓：adb logcat | grep DSHMobile
    console.error('[DSHMobile] render error', error, info?.componentStack);
  }

  private reset = () => {
    this.setState({ error: null, info: null });
    this.props.onRetry?.();
  };

  render() {
    const { error, info } = this.state;
    if (error === null) return this.props.children;
    return (
      <View style={styles.wrap}>
        <Text style={styles.title}>界面渲染出错{this.props.label ? `（${this.props.label}）` : ''}</Text>
        <Text style={styles.hint}>已拦截异常，其余功能仍可用。下面是错误详情：</Text>
        <ScrollView style={styles.box}>
          <Text style={styles.mono}>{String(error?.message ?? error)}</Text>
          {!!error?.stack && <Text style={styles.mono}>{error.stack}</Text>}
          {!!info && <Text style={styles.mono}>{info}</Text>}
        </ScrollView>
        <TouchableOpacity style={styles.btn} onPress={this.reset}>
          <Text style={styles.btnText}>重试</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 16, backgroundColor: '#fff', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '700', color: '#c0392b', marginBottom: 6 },
  hint: { fontSize: 13, color: '#666', marginBottom: 8 },
  box: { maxHeight: 320, backgroundColor: '#f6f7f9', borderRadius: 8, padding: 10 },
  mono: { fontFamily: 'monospace', fontSize: 11, lineHeight: 16, color: '#333', marginBottom: 6 },
  btn: { marginTop: 12, alignSelf: 'flex-start', backgroundColor: '#3964fe', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 20 },
  btnText: { color: '#fff', fontWeight: '600' },
});
