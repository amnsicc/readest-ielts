'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useLibrary } from '@/hooks/useLibrary';
import { useLibraryStore } from '@/store/libraryStore';
import { navigateToReader } from '@/utils/nav';
import { isWebAppPlatform } from '@/services/environment';
import { partialMD5 } from '@/utils/md5';
import { getStudyAsset } from '@/services/learning/studyAssets';
import { getStudyWorkspace } from '@/services/learning/studySession';
import catalog from '@/services/learning/catalog.json';
import {
  fixedListening,
  readingMaterials,
  speakingAudioWords,
  studySenses,
  type ReadingMaterial,
} from '@/services/learning/studyCatalog';
import type { LearningModule } from '@/services/learning/types';
import type { LearningWorkspace } from '@/services/learning/workspace';
import { LearningHome, modules } from './LearningHome';
import { ListeningLesson } from './ListeningLesson';
import { OriginalAudio } from './OriginalAudio';
import { SenseStudy } from './SenseStudy';
import { StudyLink, studyCanLeave } from './studyNavigation';

const supportsModule = (value: string | null): value is LearningModule =>
  !!value && Object.hasOwn(modules, value);

function LearningPageContent() {
  const params = useSearchParams();
  const module = params?.get('module') ?? null;
  if (!supportsModule(module)) return <LearningHome />;
  return <ModulePage key={module} module={module} material={params?.get('material') ?? null} />;
}

function ModulePage({ module, material }: { module: LearningModule; material: string | null }) {
  const { appService, envConfig } = useEnv();
  const { libraryLoaded } = useLibrary();
  const router = useRouter();
  const [workspace, setWorkspace] = useState<LearningWorkspace>();
  const [openFailure, setOpenFailure] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [readerState, setReaderState] = useState('');
  const reading = readingMaterials.find((item) => item.label === material);
  const selected = module === 'reading' ? reading !== undefined : material === 'trial';
  const [range, setRange] = useState('');
  const items = useMemo(
    () =>
      studySenses.filter((item) => {
        if (module === 'reading')
          return item.grades.reading !== undefined || item.id.startsWith('trial:sense:crust:');
        if (module === 'listening')
          return (
            item.grades.listening !== undefined &&
            fixedListening.targets.some((target) => target.originalNumber === Number(item.number))
          );
        return item.grades[module] !== undefined;
      }),
    [module],
  );

  useEffect(() => {
    if (!appService || !selected) return;
    let active = true;
    void getStudyWorkspace(appService)
      .then((value) => {
        if (active) setWorkspace(value);
      })
      .catch((error) => {
        if (active) {
          console.error('Opening learning records failed', error);
          setOpenFailure(true);
        }
      });
    return () => {
      active = false;
    };
  }, [appService, selected, attempt]);

  async function openReader(item: ReadingMaterial) {
    if (!appService || !libraryLoaded || !studyCanLeave()) return;
    setReaderState('正在打开原文…');
    try {
      const data = await getStudyAsset(item.file, item.sha256);
      const file = new File([data], item.file, { type: 'application/epub+zip' });
      const hash = await partialMD5(file);
      const library = await appService.loadLibraryBooks();
      const existing = library.find((book) => book.hash === hash && !book.deletedAt);
      const book =
        existing && (await appService.isBookAvailable(existing))
          ? existing
          : await appService.importBook(file, library, { overwrite: false });
      if (!book || book.hash !== hash) throw new Error('Reading material could not be opened');
      if (book !== existing) await useLibraryStore.getState().updateBooks(envConfig, [book]);
      setReaderState('');
      if (isWebAppPlatform()) router.push(`/reader?ids=${encodeURIComponent(book.hash)}`);
      else navigateToReader(router, [book.hash]);
    } catch {
      setReaderState('原文打开失败。请重试。');
    }
  }

  return (
    <main className='mx-auto min-h-dvh w-full max-w-3xl px-4 pb-[max(3rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8'>
      <nav aria-label='当前位置' className='mb-6 flex flex-wrap items-center gap-2 text-sm'>
        <StudyLink className='btn btn-sm btn-ghost' href='/learning'>
          学习区
        </StudyLink>
        <span aria-hidden='true'>/</span>
        {selected ? (
          <StudyLink className='btn btn-sm btn-ghost' href={`/learning?module=${module}`}>
            {modules[module][0]}
          </StudyLink>
        ) : (
          <span>{modules[module][0]}</span>
        )}
        <StudyLink className='btn btn-sm btn-ghost ms-auto' href='/library'>
          书库
        </StudyLink>
      </nav>
      <h1 className='mb-6 text-3xl font-semibold'>
        {selected
          ? module === 'reading'
            ? `001–020 阅读${reading?.label}`
            : module === 'listening'
              ? '001–010 原音练习'
              : `001–020 ${modules[module][0]}词表`
          : modules[module][0]}
      </h1>
      {!selected ? (
        <section aria-label='资料列表' className='space-y-4'>
          <label className='flex items-center gap-2'>
            原编号范围
            <select
              className='select eink-bordered'
              value={range}
              onChange={(event) => setRange(event.target.value)}
            >
              <option value=''>全部</option>
              <option>001–010</option>
              <option>001–020</option>
            </select>
          </label>
          {!range || range === (module === 'listening' ? '001–010' : '001–020') ? (
            <ul className='eink-bordered divide-base-300 bg-base-100 divide-y rounded-xl border border-base-300'>
              {(module === 'reading'
                ? readingMaterials.map((item) => [item.label, `001–020 阅读${item.label}`])
                : [
                    [
                      'trial',
                      module === 'listening'
                        ? '001–010 原音练习'
                        : `001–020 ${modules[module][0]}词表`,
                    ],
                  ]
              ).map(([id, title]) => (
                <li key={id}>
                  <StudyLink
                    className='hover:bg-base-200 block px-4 py-4'
                    href={`/learning?module=${module}&material=${id}`}
                  >
                    {title}
                  </StudyLink>
                </li>
              ))}
            </ul>
          ) : (
            <p>这个编号范围暂无资料。</p>
          )}
        </section>
      ) : !workspace ? (
        openFailure ? (
          <p role='alert'>
            无法打开学习记录。{' '}
            <button
              type='button'
              className='btn btn-sm'
              onClick={() => {
                setOpenFailure(false);
                setAttempt((value) => value + 1);
              }}
            >
              重试
            </button>
          </p>
        ) : (
          <p role='status'>正在打开学习记录…</p>
        )
      ) : (
        <div className='space-y-6' key={material}>
          {reading && (
            <div className='space-y-2'>
              <button
                type='button'
                className='btn btn-contrast'
                disabled={!libraryLoaded || readerState === '正在打开原文…'}
                onClick={() => void openReader(reading)}
              >
                打开阅读{reading.label}原文
              </button>
              {readerState && <p role='status'>{readerState}</p>}
            </div>
          )}
          {module === 'listening' && <ListeningLesson workspace={workspace} />}
          {module === 'speaking' && (
            <section className='space-y-3'>
              <h2 className='text-xl font-semibold'>原句跟读</h2>
              <p>
                这段原音可用于 {Array.from(speakingAudioWords).join('、')}{' '}
                的原句跟读。其他已选义项暂无离线独立发音。
              </p>
              <OriginalAudio sha256={fixedListening.audioSha256} />
              <p className='flex flex-wrap items-center gap-x-4 gap-y-2 text-sm'>
                <span>剑桥词典发音（需联网）</span>
                <a
                  className='link'
                  href='https://dictionary.cambridge.org/pronunciation/english/oxygen'
                  target='_blank'
                  rel='noreferrer'
                >
                  oxygen
                </a>
                <a
                  className='link'
                  href='https://dictionary.cambridge.org/pronunciation/english/core'
                  target='_blank'
                  rel='noreferrer'
                >
                  core
                </a>
              </p>
              <details>
                <summary className='cursor-pointer'>查看跟读原稿</summary>
                <p lang='en' className='mt-2 whitespace-pre-wrap font-serif leading-relaxed'>
                  {catalog.transcript}
                </p>
              </details>
            </section>
          )}
          <SenseStudy items={items} module={module} workspace={workspace} />
        </div>
      )}
    </main>
  );
}

export default function LearningPage() {
  return (
    <Suspense fallback={<p role='status'>正在打开学习区…</p>}>
      <LearningPageContent />
    </Suspense>
  );
}
