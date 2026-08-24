import { render } from 'preact';
import { App } from './App';
import './popup.css';

const root = document.getElementById('wick-root');
if (root) render(<App />, root);
