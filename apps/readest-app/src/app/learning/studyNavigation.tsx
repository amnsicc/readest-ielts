'use client';

import Link from 'next/link';
import { useLayoutEffect, type ComponentProps } from 'react';

const unsaved = new Map<symbol, boolean>();
const discardPrompt = '离开将放弃尚未保存的学习编辑。是否离开当前页面？';
let protectedEntryIndex: number | undefined;
let protectedEntryKey: string | undefined;
let restoring = false;
let refused = false;
let permitted = false;

function entryIndex() {
  return (window as unknown as { navigation?: { currentEntry?: { index: number } } }).navigation
    ?.currentEntry?.index;
}

function onEntryChange(event: Event) {
  // Some browser-initiated traversals cannot be cancelled. Restore the exact entry
  // before allowing Next's popstate restoration to replace the editor.
  if (refused || restoring) event.stopImmediatePropagation();
  if (!refused || restoring || entryIndex() === protectedEntryIndex || !protectedEntryKey) return;
  restoring = true;
  const navigation = (
    window as unknown as {
      navigation: {
        traverseTo(key: string): { committed: Promise<unknown>; finished: Promise<unknown> };
      };
    }
  ).navigation;
  const result = navigation.traverseTo(protectedEntryKey);
  void result.committed.catch(() => {});
  void result.finished.catch(() => {});
}

function onPopState(event: PopStateEvent) {
  const index = entryIndex();
  if (permitted) {
    permitted = false;
    return;
  }
  if (restoring) {
    event.stopImmediatePropagation();
    if (index === protectedEntryIndex) {
      restoring = false;
      refused = false;
    }
  } else if (
    index !== undefined &&
    protectedEntryIndex !== undefined &&
    index !== protectedEntryIndex &&
    (refused || !studyCanLeave())
  ) {
    event.stopImmediatePropagation();
    restoring = true;
    history.go(protectedEntryIndex - index);
  }
}

export function studyCanLeave() {
  if (unsaved.size === 0) return true;
  // The Tauri dialog plugin replaces window.confirm with an async IPC call.
  // History traversal needs a synchronous decision, so keep the current editor.
  if (process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri' || [...unsaved.values()].some(Boolean)) {
    return false;
  }
  return window.confirm(discardPrompt);
}

export async function studyCanClose(ask: (message: string) => boolean | Promise<boolean>) {
  if (unsaved.size === 0) return true;
  if ([...unsaved.values()].some(Boolean)) return false;
  return (await ask(discardPrompt)) === true && ![...unsaved.values()].some(Boolean);
}

function onNavigate(event: Event) {
  const traversal = event as Event & {
    navigationType?: string;
  };
  if (restoring || traversal.navigationType !== 'traverse') return;
  if (studyCanLeave()) {
    refused = false;
    permitted = true;
    return;
  }
  refused = !event.cancelable;
  if (event.cancelable) event.preventDefault();
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (unsaved.size === 0) return;
  event.preventDefault();
  event.returnValue = '';
}

export function useUnsavedStudy(dirty: boolean, saving = false) {
  useLayoutEffect(() => {
    if (!dirty && !saving) return;
    const token = Symbol();
    const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
    if (unsaved.size === 0) {
      permitted = false;
      protectedEntryIndex = entryIndex();
      protectedEntryKey = (
        navigation as (EventTarget & { currentEntry?: { key: string } }) | undefined
      )?.currentEntry?.key;
    }
    unsaved.set(token, saving);
    return () => {
      unsaved.delete(token);
      if (unsaved.size === 0) {
        refused = false;
      }
    };
  }, [dirty, saving]);
}

export function StudyHistoryGuard() {
  useLayoutEffect(() => {
    const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
    navigation?.addEventListener('navigate', onNavigate);
    navigation?.addEventListener('currententrychange', onEntryChange, true);
    window.addEventListener('popstate', onPopState, true);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      navigation?.removeEventListener('navigate', onNavigate);
      navigation?.removeEventListener('currententrychange', onEntryChange, true);
      window.removeEventListener('popstate', onPopState, true);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
  return null;
}

export function StudyLink(props: ComponentProps<typeof Link>) {
  return (
    <Link
      {...props}
      onClick={(event) => {
        if (!studyCanLeave()) event.preventDefault();
        else props.onClick?.(event);
      }}
    />
  );
}
