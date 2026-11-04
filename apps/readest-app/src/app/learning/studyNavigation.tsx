'use client';

import Link from 'next/link';
import { useEffect, type ComponentProps } from 'react';

const unsaved = new Set<symbol>();

export function studyCanLeave() {
  return unsaved.size === 0 || window.confirm('还有未保存的学习编辑。要离开当前页面吗？');
}

export function useUnsavedStudy(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const token = Symbol();
    unsaved.add(token);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      unsaved.delete(token);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [dirty]);
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
