import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import RuncellMark from './RuncellMark.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'home-hero-image': () => h(RuncellMark),
    }),
};
