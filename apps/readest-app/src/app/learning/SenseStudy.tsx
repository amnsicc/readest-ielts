'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StudySense } from '@/services/learning/catalogTypes';
import type { LearningModule, SenseView } from '@/services/learning/types';
import type { LearningWorkspace } from '@/services/learning/workspace';
import { SenseList } from './SenseList';
import { useUnsavedStudy } from './studyNavigation';

export function SenseEditor({
  item,
  view,
  module,
  workspace,
  update,
}: {
  item: StudySense;
  view: SenseView;
  module: LearningModule;
  workspace: LearningWorkspace;
  update: (value: SenseView) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [baseHeads, setBaseHeads] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mark = view.reviewMarks[module];
  useUnsavedStudy(draft !== null || busy || message.startsWith('保存失败'));
  async function save(text?: string) {
    setBusy(true);
    setMessage('保存中…');
    try {
      if (text === undefined) {
        const marked = !mark.marked;
        const receipt = await workspace.setReviewMark({
          objectId: item.id,
          module,
          marked,
          expectedHeads: mark.heads,
        });
        update({
          ...view,
          reviewMarks: {
            ...view.reviewMarks,
            [module]: { marked, heads: [receipt.revisionId], conflicts: [] },
          },
        });
      } else {
        const receipt = await workspace.setPersonalMeaning({
          senseId: item.id,
          text,
          expectedHeads: baseHeads,
        });
        update({
          ...view,
          personalMeaning: text,
          meaningHeads: [receipt.revisionId],
          meaningConflicts: [],
        });
      }
      if (text !== undefined) setDraft(null);
      setMessage('已保存');
    } catch (error) {
      setMessage(
        (error as { code?: string }).code === 'CONFLICT'
          ? '保存失败。此义项已在别处修改，请保留当前编辑并查看最新记录。'
          : '保存失败。当前编辑仍在，可重试。',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className='space-y-2'>
      {draft === null ? (
        <button
          type='button'
          className='btn btn-sm btn-ghost'
          disabled={busy || view.meaningConflicts.length > 0}
          onClick={() => {
            setBaseHeads(view.meaningHeads);
            setDraft(view.personalMeaning ?? item.meaning);
          }}
        >
          编辑个人释义
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
          className='space-y-2'
        >
          <label className='block'>
            个人释义
            <textarea
              className='textarea eink-bordered mt-1 block w-full'
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button type='submit' className='btn btn-sm btn-contrast' disabled={busy}>
            保存释义
          </button>
          <button
            type='button'
            className='btn btn-sm btn-ghost'
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setMessage('');
            }}
          >
            取消编辑
          </button>
        </form>
      )}
      <button
        type='button'
        className='btn btn-sm btn-ghost'
        disabled={busy || mark.conflicts.length > 0}
        aria-pressed={mark.marked === true}
        onClick={() => void save()}
      >
        {mark.marked ? '取消待复习' : '标为待复习'}
      </button>
      {view.meaningConflicts.length > 0 && (
        <div role='status'>
          <p>有多份个人释义，暂保留各版本。</p>
          <ul>
            {view.meaningConflicts.map((value) => (
              <li key={value.revisionId}>{String(value.value)}</li>
            ))}
          </ul>
        </div>
      )}
      {mark.conflicts.length > 0 && <p role='status'>待复习状态存在冲突，暂保留各版本。</p>}
      {message && (
        <p role='status' className='text-sm'>
          {message}
        </p>
      )}
    </div>
  );
}

export function SenseStudy({
  items,
  module,
  workspace,
}: {
  items: StudySense[];
  module: LearningModule;
  workspace: LearningWorkspace;
}) {
  const [views, setViews] = useState<Record<string, SenseView>>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all(items.map((item) => workspace.getSenseView(item.id)))
      .then((values) => {
        if (active) setViews(Object.fromEntries(values.map((view) => [view.senseId, view])));
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [items, workspace, attempt]);
  const update = useCallback(
    (value: SenseView) => setViews((previous) => ({ ...previous, [value.senseId]: value })),
    [],
  );
  if (failed)
    return (
      <div role='alert'>
        无法读取个人记录。{' '}
        <button
          type='button'
          className='btn btn-sm'
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          重试
        </button>
      </div>
    );
  if (!views) return <p role='status'>正在读取个人记录…</p>;
  return (
    <SenseList
      items={items}
      module={module}
      views={views}
      renderEdit={(item) => {
        const view = views[item.id];
        return (
          view && (
            <SenseEditor
              item={item}
              view={view}
              module={module}
              workspace={workspace}
              update={update}
            />
          )
        );
      }}
    />
  );
}
