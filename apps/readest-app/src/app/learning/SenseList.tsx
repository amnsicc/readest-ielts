import { useState, type ReactNode } from 'react';
import type { StudySense } from '@/services/learning/catalogTypes';
import type { LearningModule, SenseView } from '@/services/learning/types';
import { studyCanLeave } from './studyNavigation';

export function SenseList({
  items,
  module,
  views = {},
  renderEdit,
}: {
  items: StudySense[];
  module: LearningModule;
  views?: Record<string, SenseView>;
  renderEdit?: (item: StudySense) => ReactNode;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [grade, setGrade] = useState('');
  const [markedOnly, setMarkedOnly] = useState(false);
  const shown = items.filter(
    (item) =>
      (grade === '' || String(item.grades[module]) === grade) &&
      (!markedOnly || views[item.id]?.reviewMarks[module].marked),
  );
  return (
    <section aria-label='词表'>
      <div className='mb-4 flex flex-wrap items-center gap-4'>
        <label className='flex items-center gap-2 whitespace-nowrap'>
          档位
          <select
            className='select eink-bordered w-auto'
            value={grade}
            onChange={(event) => {
              if (studyCanLeave()) setGrade(event.target.value);
            }}
          >
            <option value=''>全部</option>
            {[0, 1, 2].map((value) => (
              <option key={value} value={value}>
                P{value}
              </option>
            ))}
          </select>
        </label>
        <label className='flex items-center gap-2'>
          <input
            type='checkbox'
            className='checkbox'
            checked={markedOnly}
            onChange={(event) => {
              if (studyCanLeave()) setMarkedOnly(event.target.checked);
            }}
          />
          只看待复习
        </label>
      </div>
      {shown.length === 0 && <p>没有符合筛选的义项。</p>}
      <ul
        aria-label='义项'
        className='eink-bordered divide-base-300 bg-base-100 divide-y rounded-xl border border-base-300'
      >
        {shown.map((item) => {
          const open = expanded.includes(item.id);
          const meaning = views[item.id]?.personalMeaning ?? item.meaning;
          const level = item.grades[module];
          return (
            <li key={item.id}>
              <button
                type='button'
                aria-expanded={open}
                onClick={() => {
                  if (!open || studyCanLeave())
                    setExpanded((previous) =>
                      open ? previous.filter((id) => id !== item.id) : [...previous, item.id],
                    );
                }}
                className='hover:bg-base-200 flex min-h-14 w-full items-center gap-3 px-4 py-2 text-start'
              >
                <span className='text-xs tabular-nums opacity-65'>{item.number}</span>
                <span className='min-w-0 flex-1 break-words font-medium'>
                  {module === 'writing' ? meaning : item.word}
                </span>
                {views[item.id]?.reviewMarks[module].marked && (
                  <span className='text-xs'>待复习</span>
                )}
                {level !== undefined && <span className='text-xs'>P{level}</span>}
                <span aria-hidden='true'>{open ? '▾' : '›'}</span>
              </button>
              {open && (
                <div className='px-4 pb-4'>
                  <p className='mb-2'>
                    <span className='opacity-70'>{item.pos}</span>{' '}
                    <span>{module === 'writing' ? item.word : meaning}</span>
                  </p>
                  {meaning !== item.meaning && (
                    <p className='mb-2 text-sm opacity-75'>源释义：{item.meaning}</p>
                  )}
                  {renderEdit?.(item)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
