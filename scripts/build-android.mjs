import { spawnSync } from 'node:child_process';

const variant = (process.argv[2] || 'debug').toLowerCase();
const tasks = variant === 'release' ? ['assembleRelease', 'bundleRelease'] : ['assembleDebug'];

function run(command, args, cwd) {
  // Windows exposes npm/npx and Gradle as .cmd/.bat launchers. Invoke them
  // through ComSpec instead of relying on shell=true (which is deprecated in
  // newer Node releases when arguments are passed separately).
  const windows = process.platform === 'win32';
  const executable = windows ? (process.env.ComSpec || 'cmd.exe') : command;
  const commandArgs = windows
    ? ['/d', '/s', '/c', [command, ...args].join(' ')]
    : args;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const root = process.cwd();
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], root);
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['cap', 'sync', 'android'], root);

const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
for (const task of tasks) {
  run(gradle, [task, '--no-daemon'], `${root}/android`);
}
