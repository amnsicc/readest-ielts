import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LearningHome } from '@/app/learning/LearningHome';

it('offers all four study modules and the library from the landing page', () => {
  render(<LearningHome />);
  for (const [label, module] of [
    ['阅读', 'reading'],
    ['听力', 'listening'],
    ['口语', 'speaking'],
    ['写作', 'writing'],
  ]) {
    expect(screen.getByRole('link', { name: new RegExp(label!) }).getAttribute('href')).toBe(
      '/learning?module=' + module,
    );
  }
  expect(screen.getByRole('link', { name: '书库' }).getAttribute('href')).toBe('/library');
});
