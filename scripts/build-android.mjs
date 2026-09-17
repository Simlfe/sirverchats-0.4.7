import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function androidBuildArgs(variant = 'debug', targets = ['aarch64', 'armv7']) {
  if (!['debug', 'release'].includes(variant)) throw new Error(`Unknown Android variant: ${variant}`);
  if (!targets.length || targets.some(target => !['aarch64', 'armv7', 'i686', 'x86_64'].includes(target))) {
    throw new Error('ANDROID_TARGETS must contain supported Tauri targets');
  }
  return ['run', 'tauri', '--', 'android', 'build', ...(variant === 'debug' ? ['--debug'] : []),
    '--target', ...targets, '--apk', ...(variant === 'release' ? ['--aab'] : []), '--ci'];
}

function run(args, root, env) {
  const windows = process.platform === 'win32';
  // Only fixed commands and validated target names reach cmd.exe.
  const result = spawnSync(windows ? (process.env.ComSpec || 'cmd.exe') : 'npm',
    windows ? ['/d', '/s', '/c', ['npm.cmd', ...args].join(' ')] : args,
    { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function buildAndroid(variant = 'debug') {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const targets = (process.env.ANDROID_TARGETS || 'aarch64,armv7').split(',').map(value => value.trim());
  const args = androidBuildArgs(variant, targets);
  const ndk = process.env.NDK_HOME || process.env.NDK_ROOT || process.env.NDKROOT;
  if (!ndk || !existsSync(resolve(ndk, 'source.properties'))) {
    throw new Error('Set NDK_HOME to an installed Android NDK (not a stale path).');
  }
  if (variant === 'release' && !existsSync(resolve(root, 'src-tauri/gen/android/keystore.properties'))) {
    throw new Error('Release signing requires src-tauri/gen/android/keystore.properties; no unsigned release fallback.');
  }
  const env = { ...process.env, NDK_HOME: ndk };
  // Regenerate ignored Gradle glue on clean checkouts; preserve native customizations.
  // Tauri runs beforeBuildCommand, so there is no separate web build or Capacitor sync.
  run(['run', 'tauri', '--', 'android', 'init', '--ci'], root, env);
  run(args, root, env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAndroid((process.argv[2] || 'debug').toLowerCase());
}
