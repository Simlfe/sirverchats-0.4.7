import test from 'node:test';
import assert from 'node:assert/strict';
import { afterFirstPaint } from '../src/services/afterPaint';

test('afterFirstPaint waits through a paint opportunity before running work', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const frames: Array<FrameRequestCallback> = [];
  const fakeWindow = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  try {
    let ran = false;
    afterFirstPaint(() => { ran = true; });
    assert.equal(frames.length, 1);
    frames.shift()?.(0);
    assert.equal(ran, false);
    assert.equal(frames.length, 1);
    frames.shift()?.(16);
    assert.equal(ran, true);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as any).window;
  }
});
