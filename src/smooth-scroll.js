import Lenis from 'lenis';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let lenis = null;
let animationFrame = 0;

function animate(time) {
  if (!lenis || document.hidden) {
    animationFrame = 0;
    return;
  }
  lenis.raf(time);
  animationFrame = requestAnimationFrame(animate);
}

function stopAnimation() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
}

function enableSmoothScroll() {
  if (lenis || reducedMotion.matches) return;
  lenis = new Lenis({
    duration: 1.15,
    easing: t => 1 - (1 - t) ** 4,
    smoothWheel: true,
    syncTouch: true,
    syncTouchLerp: 0.08,
    wheelMultiplier: 0.85,
    touchMultiplier: 1,
  });
  if (!document.hidden) animationFrame = requestAnimationFrame(animate);
}

function disableSmoothScroll() {
  stopAnimation();
  lenis?.destroy();
  lenis = null;
}

reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) {
    disableSmoothScroll();
  } else {
    enableSmoothScroll();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAnimation();
    lenis?.stop();
  } else {
    lenis?.start();
    if (lenis && !animationFrame) animationFrame = requestAnimationFrame(animate);
  }
});

enableSmoothScroll();

export function scrollToTop() {
  scrollToPosition(0);
}

export function scrollToPosition(position) {
  if (lenis) {
    lenis.scrollTo(position, { immediate: true });
  } else {
    window.scrollTo(0, position);
  }
}
