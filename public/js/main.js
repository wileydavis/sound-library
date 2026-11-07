import { initIngest } from './ingest.js';
import { initLibrary } from './library.js';
import { $$ } from './util.js';

for (const btn of $$('button.tab')) {
  btn.addEventListener('click', () => {
    for (const b of $$('button.tab')) b.classList.toggle('active', b === btn);
    for (const s of $$('main > section')) s.hidden = s.id !== `tab-${btn.dataset.tab}`;
    history.replaceState(null, '', `#${btn.dataset.tab}`);
  });
}
if (location.hash === '#add') document.querySelector('[data-tab="add"]').click();

initLibrary();
initIngest();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
