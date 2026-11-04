import { mkdtemp, rm } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SenseStudy } from '@/app/learning/SenseStudy';
import { LearningWorkspace } from '@/services/learning/workspace';
import { createDiskHost } from '../../services/learning/diskHost';

it('reads a saved personal meaning from the same sense on another material', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const root = await mkdtemp(join(tmpdir(), 'readest-stage3-ui-'));
  const workspace = await LearningWorkspace.open(createDiskHost(root));
  const item = {
    id: 'trial:sense:crust:earth',
    number: '009',
    word: 'crust',
    meaning: '地壳',
    pos: 'n.',
    grades: { reading: 1 as const },
  };
  try {
    const first = render(<SenseStudy items={[item]} module='reading' workspace={workspace} />);
    fireEvent.click(await screen.findByRole('button', { name: /crust/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑个人释义' }));
    fireEvent.change(screen.getByLabelText('个人释义'), { target: { value: '地球最外面的薄层' } });
    fireEvent.click(screen.getByRole('button', { name: '保存释义' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已保存'));
    first.unmount();
    const other = render(<SenseStudy items={[item]} module='reading' workspace={workspace} />);
    fireEvent.click(await screen.findByRole('button', { name: /crust/ }));
    expect(screen.getByText('地球最外面的薄层')).toBeTruthy();
    expect(screen.getByText('源释义：地壳')).toBeTruthy();
    other.unmount();
  } finally {
    await workspace.close();
    vi.unstubAllGlobals();
    if (
      dirname(resolve(root)) === resolve(tmpdir()) &&
      basename(root).startsWith('readest-stage3-ui-')
    )
      await rm(root, { recursive: true, force: true });
  }
});
