import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Runcell',
  description:
    'Open-source TypeScript runtime for agents that use files and tools, with sandbox workspaces, validated results, and persistent threads.',
  base: '/',
  cleanUrls: true,
  sitemap: { hostname: 'https://runcell.run' },
  // Attach each page's raw markdown (minus frontmatter) so the theme can offer
  // a "Copy Markdown" button, handy for pasting a page into an LLM.
  transformPageData(pageData, { siteConfig }) {
    if (pageData.frontmatter['layout'] === 'home') return;
    try {
      const file = path.join(siteConfig.srcDir, pageData.relativePath);
      const raw = fs.readFileSync(file, 'utf-8');
      const markdown = raw
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
        .trimStart();
      return { rawMarkdown: markdown };
    } catch {
      return;
    }
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    [
      'script',
      {
        src: 'https://context7.com/widget.js',
        'data-library': '/d4nz-jpg/runcell',
        'data-color': '#059669',
        'data-position': 'bottom-right',
        async: '',
      },
    ],
  ],
  themeConfig: {
    // The lockup carries the wordmark, so no separate site title text.
    logo: { light: '/logo-light.svg', dark: '/logo-dark.svg' },
    siteTitle: false,
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/D4NZ-jpg/runcell' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/runcell' },
    ],
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Chat agent', link: '/chat-agent' },
      { text: 'API', link: '/api' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/getting-started' },
          { text: 'Building a chat agent', link: '/chat-agent' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Sandboxes', link: '/sandboxes' },
          { text: 'Threads', link: '/threads' },
          { text: 'Structured output', link: '/structured-output' },
          { text: 'Streaming', link: '/streaming' },
          { text: 'Files, tools, and events', link: '/files-tools-events' },
          { text: 'Credentials', link: '/credentials' },
          { text: 'Pi extensions', link: '/pi-extensions' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API reference', link: '/api' },
          { text: 'Examples', link: '/examples' },
        ],
      },
    ],
    outline: { level: [2, 3] },
  },
});
