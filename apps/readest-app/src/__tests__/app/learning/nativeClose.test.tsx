import { webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUnsavedStudy } from '@/app/learning/studyNavigation';
import { SenseStudy } from '@/app/learning/SenseStudy';
import { LearningWorkspace } from '@/services/learning/workspace';
import { tauriHandleOnCloseWindow } from '@/utils/window';
import { createDiskHost } from '../../services/learning/diskHost';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn(), getAllWindows: vi.fn() }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'windows', version: () => '10.0.26200' }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('a close-time storage failure keeps the window open without an unhandled rejection', async () => {
  let closeRequested: ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
  let destroyed = false;
  vi.mocked(getCurrentWindow).mockReturnValue({
    label: 'main',
    onCloseRequested: async (handler: typeof closeRequested) => {
      closeRequested = handler;
      return () => {};
    },
    destroy: async () => {
      destroyed = true;
    },
  } as unknown as ReturnType<typeof getCurrentWindow>);
  const unlisten = await tauriHandleOnCloseWindow(() => {
    throw new Error('DISK_FULL');
  });
  try {
    await expect(closeRequested!({ preventDefault: () => {} })).resolves.toBeUndefined();
    expect(destroyed).toBe(false);
  } finally {
    unlisten();
  }
});

function Editor({ saving = false }: { saving?: boolean }) {
  useUnsavedStudy(true, saving);
  return <input aria-label='草稿' defaultValue='尚未保存的个人释义' />;
}

it('cancelling a Windows close request preserves the unsaved editor', async () => {
  let closeRequested: ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
  let destroyed = false;
  vi.mocked(getCurrentWindow).mockReturnValue({
    label: 'main',
    onCloseRequested: async (handler: typeof closeRequested) => {
      closeRequested = handler;
      return () => {};
    },
    destroy: async () => {
      destroyed = true;
    },
  } as unknown as ReturnType<typeof getCurrentWindow>);
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const view = render(<Editor />);
  const unlisten = await tauriHandleOnCloseWindow(() => {});
  try {
    await closeRequested!({ preventDefault: () => {} });
    expect(destroyed).toBe(false);
    expect((view.getByLabelText('草稿') as HTMLInputElement).value).toBe('尚未保存的个人释义');
  } finally {
    unlisten();
  }
});

it('awaits an asynchronous native confirmation before closing a dirty window', async () => {
  let request: ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
  const destroy = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getCurrentWindow).mockReturnValue({
    label: 'main',
    onCloseRequested: async (handler: typeof request) => {
      request = handler;
      return () => {};
    },
    destroy,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  vi.spyOn(window, 'confirm').mockImplementation(() => {
    return Promise.resolve(false) as unknown as boolean;
  });
  render(<Editor />);
  const unlisten = await tauriHandleOnCloseWindow(() => {});
  try {
    await request!({ preventDefault: () => {} });
    expect(destroy).not.toHaveBeenCalled();
  } finally {
    unlisten();
  }
});

it('blocks close during a save and preserves a failed draft until a successful retry', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const root = await mkdtemp(join(tmpdir(), 'readest-windows-close-'));
  let fail = false;
  let hold: Promise<void> | undefined;
  let release = () => {};
  const disk = createDiskHost(root);
  const host = {
    ...disk,
    async openDatabase(...args: Parameters<typeof disk.openDatabase>) {
      const db = await disk.openDatabase(...args);
      return {
        ...db,
        async execute(...args: Parameters<typeof db.execute>) {
          await hold;
          if (fail) throw new Error('DISK_FULL');
          return db.execute(...args);
        },
      };
    },
  };
  const workspace = await LearningWorkspace.open(host);
  let request: ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
  const destroy = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getCurrentWindow).mockReturnValue({
    label: 'main',
    onCloseRequested: async (handler: typeof request) => {
      request = handler;
      return () => {};
    },
    destroy,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const unlisten = await tauriHandleOnCloseWindow(() => workspace.close());
  const item = {
    id: 'trial:sense:crust:earth',
    number: '009',
    word: 'crust',
    meaning: '地壳',
    pos: 'n.',
    grades: { reading: 1 as const },
  };
  const draft = '地球的最外层';
  try {
    render(<SenseStudy items={[item]} module='reading' workspace={workspace} />);
    fireEvent.click(await screen.findByRole('button', { name: /crust/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑个人释义' }));
    fireEvent.change(screen.getByLabelText('个人释义'), { target: { value: draft } });
    fail = true;
    hold = new Promise<void>((done) => {
      release = done;
    });
    fireEvent.click(screen.getByRole('button', { name: '保存释义' }));
    await request!({ preventDefault: () => {} });
    expect(destroy).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    release();
    await screen.findByText('保存失败。当前编辑仍在，可重试。');
    await request!({ preventDefault: () => {} });
    expect(destroy).not.toHaveBeenCalled();
    expect((screen.getByLabelText('个人释义') as HTMLTextAreaElement).value).toBe(draft);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '保存释义' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已保存'));
    await request!({ preventDefault: () => {} });
    expect(destroy).toHaveBeenCalledOnce();
    const reopened = await LearningWorkspace.open(disk);
    try {
      expect((await reopened.getSenseView(item.id)).personalMeaning).toBe(draft);
    } finally {
      await reopened.close();
    }
  } finally {
    release();
    unlisten();
    await workspace.close().catch(() => {});
    if (
      dirname(resolve(root)) === resolve(tmpdir()) &&
      basename(root).startsWith('readest-windows-close-')
    ) {
      await rm(root, { recursive: true, force: true });
    }
  }
});
