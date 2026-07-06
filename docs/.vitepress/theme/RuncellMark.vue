<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

/**
 * The hero mark, alive: the cursor blinks like a terminal at rest, goes solid
 * on hover (a focused terminal), and the cell tilts toward the pointer with a
 * small spring. Tilt is gated to fine pointers and disabled under
 * prefers-reduced-motion; the blink is pure CSS.
 */

const root = ref<HTMLElement>();
const svg = ref<SVGSVGElement>();
const cursor = ref<SVGRectElement>();

let burst: Animation | undefined;

/** Quick double-blink on press, like tapping a terminal. Runs above the CSS
 * hover state and reverts on its own; rapid clicks restart it. */
function blinkBurst() {
  const el = cursor.value;
  if (!el || typeof el.animate !== 'function') {
    return;
  }
  burst?.cancel();
  burst = el.animate(
    [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 }],
    { duration: 420, easing: 'steps(1, end)' },
  );
}

let raf = 0;
let running = false;
let detach: (() => void) | undefined;

// Spring state: current angle, velocity, target angle (deg).
let cx = 0;
let cy = 0;
let vx = 0;
let vy = 0;
let tx = 0;
let ty = 0;

const STIFFNESS = 140;
const DAMPING = 16;
const MAX_TILT = 8;

function step(last: number) {
  raf = requestAnimationFrame(now => {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    vx += (STIFFNESS * (tx - cx) - DAMPING * vx) * dt;
    cx += vx * dt;
    vy += (STIFFNESS * (ty - cy) - DAMPING * vy) * dt;
    cy += vy * dt;

    if (svg.value) {
      svg.value.style.transform = `rotateX(${cy.toFixed(2)}deg) rotateY(${cx.toFixed(2)}deg)`;
    }

    const settled =
      Math.abs(tx - cx) < 0.02 &&
      Math.abs(ty - cy) < 0.02 &&
      Math.abs(vx) < 0.02 &&
      Math.abs(vy) < 0.02;
    if (settled && tx === 0 && ty === 0) {
      running = false;
      return;
    }
    step(now);
  });
}

function ensureRunning() {
  if (!running) {
    running = true;
    step(performance.now());
  }
}

onMounted(() => {
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const el = root.value;
  if (!el || !fine.matches || reduced.matches) {
    return;
  }

  const onMove = (event: PointerEvent) => {
    const box = el.getBoundingClientRect();
    const dx = (event.clientX - box.left) / box.width - 0.5;
    const dy = (event.clientY - box.top) / box.height - 0.5;
    tx = dx * 2 * MAX_TILT;
    ty = -dy * 2 * MAX_TILT;
    ensureRunning();
  };
  const onLeave = () => {
    tx = 0;
    ty = 0;
    ensureRunning();
  };

  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerleave', onLeave);
  detach = () => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerleave', onLeave);
  };
});

onUnmounted(() => {
  detach?.();
  cancelAnimationFrame(raf);
  burst?.cancel();
});
</script>

<template>
  <div ref="root" class="rc-mark" aria-hidden="true" @pointerdown="blinkBurst">
    <svg ref="svg" viewBox="0 0 40 40" fill="none">
      <rect
        x="3"
        y="3"
        width="34"
        height="34"
        rx="9"
        stroke="currentColor"
        stroke-width="3"
      />
      <rect
        ref="cursor"
        class="rc-cursor"
        x="15.5"
        y="12"
        width="9"
        height="16"
        rx="2"
        fill="currentColor"
      />
    </svg>
  </div>
</template>

<style scoped>
.rc-mark {
  position: absolute;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  width: 192px;
  height: 192px;
  perspective: 640px;
  color: var(--vp-c-text-1);
  transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
}

@media (prefers-reduced-motion: no-preference) {
  .rc-mark:active {
    transform: scale(0.97);
  }
}

@media (min-width: 640px) {
  .rc-mark {
    width: 256px;
    height: 256px;
  }
}

@media (min-width: 960px) {
  .rc-mark {
    width: 306px;
    height: 306px;
  }
}

.rc-mark svg {
  display: block;
  width: 100%;
  height: 100%;
  will-change: transform;
}

/* A terminal at rest blinks. */
.rc-cursor {
  animation: rc-blink 1.1s steps(1, end) infinite;
}

/* A focused terminal doesn't. */
.rc-mark:hover .rc-cursor {
  animation: none;
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .rc-cursor {
    animation: none;
  }
}

@keyframes rc-blink {
  0%,
  55% {
    opacity: 1;
  }
  56%,
  100% {
    opacity: 0;
  }
}
</style>
