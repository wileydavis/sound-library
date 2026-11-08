import { initIngest } from './ingest.js';
import { initLibrary } from './library.js';
import { initWhere, setWhereActive } from './where.js';
import { $$ } from './util.js';

const TABS = ['library', 'add', 'where'];

function showTab(name) {
  if (!TABS.includes(name)) name = 'library';
  for (const b of $$('button.tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of $$('main > section')) s.hidden = s.id !== `tab-${name}`;
  setWhereActive(name === 'where');
  if (location.hash.slice(1) !== name) history.replaceState(null, '', name === 'library' ? location.pathname : `#${name}`);
}

for (const btn of $$('button.tab')) btn.addEventListener('click', () => showTab(btn.dataset.tab));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

initWhere();
initLibrary();
initIngest();
showTab(location.hash.slice(1) || 'library');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
