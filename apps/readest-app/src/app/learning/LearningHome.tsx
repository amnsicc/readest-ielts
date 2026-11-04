import Link from 'next/link';

export const modules = {
  reading: ['阅读', '读原文，查本篇用义'],
  listening: ['听力', '听原音，填出现序号'],
  speaking: ['口语', '查音，跟读原句'],
  writing: ['写作', '从中文提示回想英文'],
} as const;

export function LearningHome() {
  return (
    <main className='mx-auto min-h-dvh w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-14'>
      <header className='mb-8 flex items-center justify-between gap-4'>
        <h1 className='text-3xl font-semibold'>学习区</h1>
        <Link className='btn btn-ghost' href='/library'>
          书库
        </Link>
      </header>
      <nav
        aria-label='学习模块'
        className='eink-bordered divide-base-300 bg-base-100 divide-y rounded-xl border border-base-300'
      >
        {Object.entries(modules).map(([id, [label, description]]) => (
          <Link
            key={id}
            href={`/learning?module=${id}`}
            className='hover:bg-base-200 focus-visible:outline-primary flex min-h-20 items-center justify-between gap-3 px-5 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2'
          >
            <span>
              <strong className='block text-lg'>{label}</strong>
              <span className='text-sm opacity-75'>{description}</span>
            </span>
            <span aria-hidden='true' className='text-xl'>
              ›
            </span>
          </Link>
        ))}
      </nav>
    </main>
  );
}
