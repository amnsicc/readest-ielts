import { readingMaterials, studySenses, type ReadingMaterial } from './studyCatalog';
import type { StudySense } from './catalogTypes';

const checkedFiles = new WeakMap<File, Promise<ReadingMaterial | undefined>>();

export interface ReaderStudyTarget {
  item: StudySense;
  element: HTMLElement;
}

export function findReadingMaterial(file: File) {
  let result = checkedFiles.get(file);
  if (!result) {
    result =
      file.size <= 16000
        ? file
            .arrayBuffer()
            .then(async (bytes) => {
              const digest = await crypto.subtle.digest('SHA-256', bytes);
              const sha256 = Array.from(new Uint8Array(digest), (byte) =>
                byte.toString(16).padStart(2, '0'),
              ).join('');
              return readingMaterials.find((material) => material.sha256 === sha256);
            })
            .catch(() => undefined)
        : Promise.resolve(undefined);
    checkedFiles.set(file, result);
  }
  return result;
}

export function registerReadingTargets(
  doc: Document,
  material: ReadingMaterial,
  section: string,
  open: (target: ReaderStudyTarget) => void,
) {
  if (section !== material.section) return;
  for (const location of material.locations) {
    const paragraph = doc.getElementById(location.paragraph);
    const link =
      paragraph &&
      [...paragraph.querySelectorAll('a')].find(
        (anchor) =>
          anchor.getAttribute('href') === location.anchor ||
          anchor.getAttribute('href') === section + location.anchor,
      );
    const element = link?.previousElementSibling as HTMLElement | null | undefined;
    const item = studySenses.find((sense) => sense.id === location.senseId);
    if (
      !element ||
      !link ||
      !item ||
      element.tagName.toLowerCase() !== 'strong' ||
      element.textContent !== location.actual ||
      element.dataset['learningSense']
    )
      continue;
    element.dataset['learningSense'] = item.id;
    element.setAttribute('role', 'button');
    element.tabIndex = 0;
    function activate(event: Event) {
      if (event.defaultPrevented || doc.getSelection()?.isCollapsed === false) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      open({ item: item!, element: element! });
    }
    element.addEventListener('click', activate, true);
    link.addEventListener('click', activate, true);
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });
  }
}
