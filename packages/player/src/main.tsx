import { render } from 'preact';
import { registerServiceWorker } from './app/pwa.ts';
import { toast } from './app/store.ts';
import { t } from './i18n/i18n.ts';
import { App } from './ui/app.tsx';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app element');
render(<App />, root);
registerServiceWorker(() => toast(t('app.updated'), 'info', 10_000));
