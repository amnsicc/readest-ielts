import { fireEvent, render, screen, within } from '@testing-library/react';

import { expect, it } from 'vitest';
import { SenseList } from '@/app/learning/SenseList';

const items = [
  {
    id: 'earth',
    number: '009',
    word: 'crust',
    meaning: '地壳',
    pos: 'n.',
    grades: { reading: 1 as const },
  },
  {
    id: 'bread',
    number: '009',
    word: 'crust',
    meaning: '面包皮',
    pos: 'n.',
    grades: { reading: 1 as const },
  },
  {
    id: 'sky',
    number: '013',
    word: 'horizon',
    meaning: '地平线',
    pos: 'n.',
    grades: { reading: 2 as const },
  },
];

it('reveals separate senses in place and filters actual rows by grade', () => {
  const props = { items, module: 'reading' as const };
  const { unmount } = render(<SenseList {...props} />);
  expect(screen.queryByText('地壳')).toBeNull();
  for (const button of screen.getAllByRole('button', { name: /crust/ })) fireEvent.click(button);
  expect(screen.getByText('地壳')).toBeTruthy();
  expect(screen.getByText('面包皮')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('档位'), { target: { value: '2' } });
  expect(within(screen.getByRole('list', { name: '义项' })).queryByText('crust')).toBeNull();
  expect(screen.getByRole('button', { name: /horizon/ })).toBeTruthy();
  unmount();
  render(<SenseList {...props} />);
  expect(screen.queryByText('地壳')).toBeNull();
});
