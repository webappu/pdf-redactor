import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { initLang } from './i18n.svelte';

// 画面を作る前に言語を決める（保存した言語 → 端末の時間帯で仮に → アクセス元の国で決め直す）
initLang();

const target = document.getElementById('app');
if (!target) throw new Error('#app が見つかりません');

export default mount(App, { target });
