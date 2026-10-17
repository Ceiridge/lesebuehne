import { render } from 'preact';
import { App } from './ui/app.tsx';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app element');
render(<App />, root);
