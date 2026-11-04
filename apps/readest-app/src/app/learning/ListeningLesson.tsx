'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import type {
  ExerciseDefinition,
  ExerciseView,
  ListeningResult,
  RawInputs,
  RoundView,
} from '@/services/learning/listening';
import type { LearningWorkspace } from '@/services/learning/workspace';
import catalog from '@/services/learning/catalog.json';
import { fixedListening as fixed } from '@/services/learning/studyCatalog';
import { OriginalAudio } from './OriginalAudio';
import { useUnsavedStudy } from './studyNavigation';

const transcript = catalog.transcript.split(/\r?\n\s*\r?\n/);
const formatResult = (result: ListeningResult) =>
  result.percentage === null
    ? '已填写序号准确率 未计算'
    : `已填写序号准确率 ${result.correct}/${result.submitted}（${Number(result.percentage.toFixed(2))}%）`;

export function ListeningLesson({
  workspace,
  definition = fixed,
}: {
  workspace: LearningWorkspace;
  definition?: ExerciseDefinition;
}) {
  const [exercise, setExercise] = useState<ExerciseView>();
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void workspace
      .registerExerciseVersion(definition)
      .then(() => workspace.openExercise(definition.exerciseId))
      .then((value) => {
        if (active) setExercise(value);
      })
      .catch((error) => {
        if (active) {
          console.error('Opening listening exercise failed', error);
          setError('无法打开练习。');
        }
      });
    return () => {
      active = false;
    };
  }, [workspace, definition, retry]);
  if (!exercise)
    return error ? (
      <p role='alert'>
        {error}{' '}
        <button
          type='button'
          className='btn btn-sm'
          onClick={() => {
            setError('');
            setRetry((n) => n + 1);
          }}
        >
          重试
        </button>
      </p>
    ) : (
      <p role='status'>正在打开练习…</p>
    );
  return (
    <RoundForm
      key={exercise.currentRound.roundId}
      workspace={workspace}
      exercise={exercise}
      onNew={setExercise}
    />
  );
}

function RoundForm({
  workspace,
  exercise,
  onNew,
}: {
  workspace: LearningWorkspace;
  exercise: ExerciseView;
  onNew: (value: ExerciseView) => void;
}) {
  const [round, setRound] = useState(exercise.currentRound);
  const [draft, setDraft] = useState<RawInputs>(round.rawInputs);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [answers, setAnswers] = useState(round.result !== null);
  const [busy, setBusy] = useState<'save' | 'check' | 'new' | null>(null);
  const inFlight = useRef(false);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const dirty = Object.keys(draft).some((id) => draft[id] !== round.rawInputs[id]);
  useUnsavedStudy(dirty || failed, busy !== null);

  async function action(kind: 'save' | 'check' | 'new') {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setStatus('');
    try {
      let saved: RoundView = round;
      if (dirty) {
        const receipt = await workspace.saveDraft({
          roundId: round.roundId,
          rawInputs: draft,
          expectedHeads: round.draftHeads,
        });
        saved = { ...round, rawInputs: draft, draftHeads: [receipt.revisionId] };
        setRound(saved);
      }
      if (kind === 'check') {
        const checked = await workspace.checkRound(saved.roundId);
        setRound(checked);
        setAnswers(true);
      }
      if (kind === 'new') {
        await workspace.startNewRound(round.exerciseId);
        onNew(await workspace.openExercise(round.exerciseId));
      }
      setFailed(false);
      setStatus('已保存');
    } catch (error) {
      const problem = error as { code?: string; issues?: { targetId: string; token: string }[] };
      setFailed(problem.code === 'SAVE_FAILED');
      if (problem.code === 'INVALID_ANSWER') {
        const issues = problem.issues
          ?.map((issue) => {
            const target = round.definition.targets.find(
              (item) => item.targetId === issue.targetId,
            );
            return `${target?.word ?? issue.targetId}：${issue.token}`;
          })
          .join('；');
        setStatus(`填写已保存。请修正以下序号：${issues ?? ''}`);
      } else {
        setStatus(
          problem.code === 'CONFLICT'
            ? '记录已在别处修改。请保留当前填写并核对最新记录。'
            : '操作失败。当前填写仍在，请重试。',
        );
      }
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  }

  useEffect(() => {
    if (!dirty || busy || (status && status !== '已保存')) return;
    const timer = window.setTimeout(() => void action('save'), 650);
    return () => window.clearTimeout(timer);
  });

  const sourceMatches =
    round.definition.audioAssetId === fixed.audioAssetId &&
    round.definition.audioSha256 === fixed.audioSha256;
  const words = fixed.targets.map((target) => target.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const highlight = new RegExp(`(\\b(?:${words.join('|')})\\b)`, 'gi');
  const history = exercise.rounds.map((item) => (item.roundId === round.roundId ? round : item));

  return (
    <section aria-label='听力练习' className='space-y-5'>
      {sourceMatches && <OriginalAudio sha256={round.definition.audioSha256} />}
      {!sourceMatches && (
        <p role='status'>当前轮的原音和原稿未在本机提供。仍可查看或填写本轮记录。</p>
      )}
      {sourceMatches && (
        <div className='eink-bordered bg-base-100 rounded-xl border border-base-300'>
          <button
            type='button'
            className='btn btn-ghost w-full justify-start'
            aria-expanded={transcriptOpen}
            aria-controls='study-transcript'
            onClick={() => setTranscriptOpen((open) => !open)}
          >
            {transcriptOpen ? '收起原稿' : '展开原稿'}
          </button>
          <div
            id='study-transcript'
            hidden={!transcriptOpen}
            className='max-h-[48dvh] space-y-3 overflow-y-auto px-4 pb-4 font-serif leading-relaxed'
            lang='en'
          >
            {transcript.map((paragraph, index) => (
              <p key={index}>
                {paragraph.split(highlight).map((part, i) =>
                  i % 2 ? (
                    <mark
                      className='bg-warning/30 text-base-content rounded-sm px-0.5 underline decoration-1 underline-offset-2'
                      key={i}
                    >
                      {part}
                    </mark>
                  ) : (
                    <Fragment key={i}>{part}</Fragment>
                  ),
                )}
              </p>
            ))}
          </div>
        </div>
      )}
      <ol className='eink-bordered divide-base-300 bg-base-100 divide-y rounded-xl border border-base-300'>
        {round.definition.targets.map((target) => (
          <li
            key={target.targetId}
            className='grid gap-2 px-4 py-3 sm:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)] sm:items-center'
          >
            <label htmlFor={`fill-${target.targetId}`} className='flex items-baseline gap-3'>
              <span aria-hidden='true' className='text-xs tabular-nums opacity-65'>
                {String(target.originalNumber).padStart(3, '0')}
              </span>
              <span lang='en' className='font-medium'>
                {target.word}
              </span>
              <span className='sr-only'> 出现序号</span>
            </label>
            <div className='space-y-1'>
              <input
                id={`fill-${target.targetId}`}
                aria-label={`${target.word} 出现序号`}
                className='input eink-bordered w-full'
                type='text'
                value={draft[target.targetId] ?? ''}
                placeholder='例如 1、3'
                maxLength={16384}
                autoComplete='off'
                readOnly={busy === 'new' || busy === 'check'}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((previous) => ({ ...previous, [target.targetId]: value }));
                  setStatus('');
                }}
              />
              {answers && <p className='text-sm'>正确序号 {target.correctNumbers.join('、')}</p>}
            </div>
          </li>
        ))}
      </ol>
      <div className='flex flex-wrap gap-2'>
        <button
          type='button'
          className='btn btn-contrast'
          disabled={busy !== null}
          onClick={() => void action('check')}
        >
          核对
        </button>
        <button
          type='button'
          className='btn btn-ghost'
          disabled={busy !== null}
          onClick={() => void action('save')}
        >
          保存填写
        </button>
        <button
          type='button'
          className='btn btn-ghost'
          disabled={busy !== null}
          onClick={() => void action('new')}
        >
          新一轮
        </button>
        {round.result && (
          <button type='button' className='btn btn-ghost' onClick={() => setAnswers(!answers)}>
            {answers ? '隐藏正确序号' : '显示正确序号'}
          </button>
        )}
      </div>
      <p role='status' className='text-sm'>
        {busy
          ? '保存中…'
          : dirty && (!status || status === '已保存')
            ? '待保存'
            : status || '已保存'}
      </p>
      {round.result && (
        <div className='space-y-1'>
          <p className='font-semibold'>{formatResult(round.result)}</p>
          <p className='text-sm'>
            尚未正确对应 {round.result.unmatchedExpected} / {round.result.totalExpected}{' '}
            个答案事件。准确率仅按已填写序号计算。
          </p>
          {!!round.result.duplicates.length && (
            <p className='text-sm'>重复序号已合并计分，原填写已保留。</p>
          )}
        </div>
      )}
      <section className='space-y-2' aria-label='历史轮次'>
        <h2 className='text-lg font-semibold'>历史轮次</h2>
        {history.map((item, index) => (
          <details
            key={item.roundId}
            className='eink-bordered rounded-lg border border-base-300 p-3'
          >
            <summary className='cursor-pointer'>
              第 {index + 1} 轮 ·{' '}
              {item.result ? `${item.result.correct}/${item.result.submitted}` : '未核对'}
            </summary>
            {item.result && (
              <p className='text-sm'>
                {new Date(item.result.checkedAt).toLocaleString()} · {formatResult(item.result)}
              </p>
            )}
            <dl className='mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1 text-sm'>
              {item.definition.targets.map((target) => (
                <Fragment key={target.targetId}>
                  <dt>{target.word}</dt>
                  <dd className='whitespace-pre-wrap break-words'>
                    {(item.result?.rawInputs ?? item.rawInputs)[target.targetId] || '空白'}
                  </dd>
                </Fragment>
              ))}
            </dl>
            {item.result &&
              item.definition.targets.some(
                (target) =>
                  item.rawInputs[target.targetId] !== item.result?.rawInputs[target.targetId],
              ) && (
                <div className='mt-3'>
                  <p className='font-medium'>核对后的填写</p>
                  <dl className='grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1 text-sm'>
                    {item.definition.targets.map((target) => (
                      <Fragment key={target.targetId}>
                        <dt>{target.word}</dt>
                        <dd className='whitespace-pre-wrap break-words'>
                          {item.rawInputs[target.targetId] || '空白'}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                </div>
              )}
          </details>
        ))}
      </section>
    </section>
  );
}
