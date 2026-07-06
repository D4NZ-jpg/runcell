<script setup lang="ts">
import { computed, ref } from 'vue';
import { useData } from 'vitepress';

// `rawMarkdown` is attached per page by transformPageData in config.ts.
const { page } = useData();
const markdown = computed(
  () => (page.value as { rawMarkdown?: string }).rawMarkdown,
);

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Copy text across browsers. Prefers the async Clipboard API (secure contexts),
 * and falls back to a hidden-textarea execCommand for Firefox quirks and
 * non-secure contexts (e.g. serving the preview over a LAN IP).
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

async function copy() {
  const md = markdown.value;
  if (!md) return;
  const ok = await writeClipboard(md);
  if (!ok) return;
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => (copied.value = false), 1600);
}
</script>

<template>
  <div v-if="markdown" class="rc-copy-md">
    <button
      class="rc-copy-btn"
      type="button"
      :data-copied="copied"
      :aria-label="copied ? 'Copied' : 'Copy this page as Markdown'"
      @click="copy"
    >
      <svg
        v-if="!copied"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      <svg
        v-else
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      <span>{{ copied ? 'Copied' : 'Copy Markdown' }}</span>
    </button>
  </div>
</template>

<style scoped>
.rc-copy-md {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.rc-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  line-height: 1;
  color: var(--vp-c-text-2);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 6px 10px;
  transition:
    color 150ms ease,
    border-color 150ms ease,
    background-color 150ms ease,
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

@media (hover: hover) and (pointer: fine) {
  .rc-copy-btn:hover {
    color: var(--vp-c-text-1);
    border-color: var(--vp-c-text-3);
    background: var(--vp-c-bg-soft);
  }
}

.rc-copy-btn:active {
  transform: scale(0.97);
}

.rc-copy-btn[data-copied='true'] {
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-text-3);
}
</style>
