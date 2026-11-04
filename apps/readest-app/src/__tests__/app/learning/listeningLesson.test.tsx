import { mkdtemp, rm } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ListeningLesson } from '@/app/learning/ListeningLesson';
import { LearningWorkspace } from '@/services/learning/workspace';
import { createDiskHost } from '../../services/learning/diskHost';

it('keeps input through transcript disclosure, checks it, then resumes the same round', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const root = await mkdtemp(join(tmpdir(), 'readest-stage3-ui-'));
  const host = createDiskHost(root);
  let workspace = await LearningWorkspace.open(host);
  try {
    const first = render(<ListeningLesson workspace={workspace} />);
    const input = (await screen.findByRole('textbox', {
      name: 'atmosphere 出现序号',
    })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1、8' } });
    fireEvent.click(screen.getByRole('button', { name: '展开原稿' }));
    expect(screen.getByText(/Before the school group arrives/)).toBeTruthy();
    expect(input.value).toBe('1、8');
    fireEvent.click(screen.getByRole('button', { name: '收起原稿' }));
    fireEvent.click(screen.getByRole('button', { name: '核对' }));
    expect(await screen.findByText('已填写序号准确率 1/2（50%）')).toBeTruthy();
    first.unmount();
    await workspace.close();
    workspace = await LearningWorkspace.open(host);
    const second = render(<ListeningLesson workspace={workspace} />);
    const resumed = (await screen.findByRole('textbox', {
      name: 'atmosphere 出现序号',
    })) as HTMLInputElement;
    expect(resumed.value).toBe('1、8');
    expect(screen.getByText('已填写序号准确率 1/2（50%）')).toBeTruthy();
    second.unmount();
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
