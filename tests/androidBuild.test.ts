import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { androidBuildArgs } from '../scripts/build-android.mjs';

test('Android APK commands use Tauri and default to both phone ARM architectures', () => {
  assert.deepEqual(androidBuildArgs(), ['run', 'tauri', '--', 'android', 'build', '--debug', '--target', 'aarch64', 'armv7', '--apk', '--ci']);
  assert.ok(!androidBuildArgs('release').includes('--debug'));
  assert.ok(androidBuildArgs('release').includes('--aab'));
  assert.throws(() => androidBuildArgs('invalid'));
  assert.throws(() => androidBuildArgs('debug', ['aarch64;echo']));
});

test('Android entry points and CI cannot silently build the legacy Capacitor shell', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name.startsWith('build:android')) assert.match(String(command), /scripts\/build-android\.mjs/);
  }
  const workflow = readFileSync(new URL('../.github/workflows/build-android.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /cap sync|working-directory: android|path: android\//);
  assert.match(workflow, /src-tauri\/gen\/android\/app\/build\/outputs/);
  assert.match(workflow, /if-no-files-found: error/);
});
