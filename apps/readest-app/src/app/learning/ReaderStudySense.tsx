'use client';

import { useEffect, useRef, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { eventDispatcher } from '@/utils/event';
import { getStudyWorkspace } from '@/services/learning/studySession';
import type { ReaderStudyTarget } from '@/services/learning/readerBridge';
import type { LearningWorkspace } from '@/services/learning/workspace';
import type { SenseView } from '@/services/learning/types';
import { SenseEditor } from './SenseStudy';
import { studyCanLeave } from './studyNavigation';

export function ReaderStudySense({
  target,
  bookKey,
  dismiss,
}: {
  target: ReaderStudyTarget;
  bookKey: string;
  dismiss: () => void;
}) {
  const { appService } = useEnv();
  const dialog = useRef<HTMLDialogElement>(null);
  const [workspace, setWorkspace] = useState<LearningWorkspace>();
  const [view, setView] = useState<SenseView>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const { item } = target;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    if (!appService) return;
    let active = true;
    void getStudyWorkspace(appService)
      .then(async (session) => {
        const value = await session.getSenseView(item.id);
        if (active) {
          setWorkspace(session);
          setView(value);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [appService, item.id, retry]);

  function close(dictionary: boolean) {
    if (!studyCanLeave()) return;
    dismiss();
    if (dictionary)
      void eventDispatcher.dispatch('wordlens-dictionary', {
        bookKey,
        word: target.element.textContent,
        element: target.element,
      });
  }

  return (
    <dialog
      ref={dialog}
      aria-label='本篇用义'
      onCancel={(event) => {
        event.preventDefault();
        close(false);
      }}
      className='modal-box eink-bordered bg-base-100 text-base-content fixed inset-0 m-auto max-h-[85dvh] w-[min(94vw,34rem)] overflow-auto rounded-xl border border-base-300 p-5 backdrop:bg-black/30'
    >
      <div className='mb-3 flex items-center justify-between gap-2'>
        <h2 className='text-lg font-semibold'>本篇用义</h2>
        <button type='button' className='btn btn-ghost btn-sm' onClick={() => close(false)}>
          关闭
        </button>
      </div>
      <p lang='en' className='text-xl font-semibold'>
        {item.word}
      </p>
      <p className='my-2'>{view?.personalMeaning ?? item.meaning}</p>
      {view?.personalMeaning != null && <p className='mb-2 text-sm'>源释义：{item.meaning}</p>}
      {view && workspace && (
        <SenseEditor
          item={item}
          view={view}
          module='reading'
          workspace={workspace}
          update={setView}
        />
      )}
      {error && (
        <p role='alert'>
          无法读取个人释义。{' '}
          <button
            type='button'
            className='btn btn-sm'
            onClick={() => {
              setError(false);
              setRetry((value) => value + 1);
            }}
          >
            重试
          </button>
        </p>
      )}
      <button type='button' className='btn btn-ghost mt-3' onClick={() => close(true)}>
        通用词典
      </button>
    </dialog>
  );
}
