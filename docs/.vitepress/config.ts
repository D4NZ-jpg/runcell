import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitepress';

// GitHub Pages project sites serve under /<repo>/. The deploy workflow sets
// DOCS_BASE accordingly; local dev and preview default to '/'.
const base = process.env['DOCS_BASE'] ?? '/';

export default defineConfig({
  title: 'Runcell',
  description:
    'Run AI agents in isolated sandbox cells — streamed replies, durable conversations, validated structured output.',
  base,
  cleanUrls: true,
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
    [
      'link',
      { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` },
    ],
  ],
  themeConfig: {
    // The lockup carries the wordmark, so no separate site title text.
    logo: { light: '/logo-light.svg', dark: '/logo-dark.svg' },
    siteTitle: false,
    search: { provider: 'local' },
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
