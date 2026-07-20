<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Sun, Moon } from 'lucide-vue-next';

type Theme = 'light' | 'dark';

const theme = ref<Theme>('light');
const mounted = ref(false);

function resolveCurrentTheme(): Theme {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'light' || explicit === 'dark') return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

onMounted(() => {
  theme.value = resolveCurrentTheme();
  mounted.value = true;
});

function toggle() {
  const next: Theme = theme.value === 'dark' ? 'light' : 'dark';
  theme.value = next;
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('packsheet-theme', next);
  } catch {
    // Private mode blocks writes. The toggle still works for this page view.
  }
}
</script>

<template>
  <button
    type="button"
    class="border-hairline bg-surface text-ink-2 hover:text-ink inline-flex items-center gap-2 rounded-[var(--r-sm)] border px-3 py-2 text-sm transition-colors"
    :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
    @click="toggle"
  >
    <!--
      Render nothing icon-wise until mounted. The server cannot know the visitor's
      OS preference, so committing to an icon during SSR guarantees it is wrong for
      half of visitors and then visibly swaps.
    -->
    <component :is="theme === 'dark' ? Sun : Moon" v-if="mounted" :size="16" aria-hidden="true" />
    <span v-else class="inline-block h-4 w-4" aria-hidden="true" />
    <span>{{ mounted && theme === 'dark' ? 'Light' : 'Dark' }}</span>
  </button>
</template>
