import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const apiBase = 'https://api.github.com';
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const sourceCommit = process.env.WORKFLOW_RUN_HEAD_SHA;
const targetDir = process.env.LANDING_DOWNLOADS_DIR || '/var/www/html/downloads';

const requiredWorkflows = {
  'Build and Deploy Windows App': {
    artifact: 'SirverData-Windows-Setup',
    extension: '.exe',
    filename: version => `SirverData-${version}-Windows-x64.exe`,
  },
  'Build and Deploy Linux App': {
    artifact: 'SirverData-Linux-Packages',
    extension: null,
    filenames: {
      '.deb': version => `SirverData-${version}-Linux-x64.deb`,
      '.AppImage': version => `SirverData-${version}-Linux-x64.AppImage`,
    },
  },
  'Build Tauri Android App': {
    artifact: 'SirverData-Tauri-Android-Debug-APK',
    extension: '.apk',
    filename: version => `SirverData-${version}-Android.apk`,
  },
};

if (!repository || !token || !sourceCommit) {
  throw new Error('GITHUB_REPOSITORY, GITHUB_TOKEN, and WORKFLOW_RUN_HEAD_SHA are required.');
}

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
};

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function github(pathname) {
  const response = await fetch(`${apiBase}${pathname}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${pathname}: ${await response.text()}`);
  }
  return response.json();
}

async function findBuildRuns() {
  const data = await github(`/repos/${repository}/actions/runs?head_sha=${sourceCommit}&per_page=100`);
  const runs = new Map();
  for (const workflowName of Object.keys(requiredWorkflows)) {
    const run = data.workflow_runs
      .filter(candidate => candidate.name === workflowName)
      .sort((left, right) => right.id - left.id)[0];
    runs.set(workflowName, run);
  }
  return runs;
}

async function waitForSuccessfulBuilds() {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const runs = await findBuildRuns();
    let pending = false;
    for (const [workflowName, run] of runs) {
      if (!run) {
        pending = true;
        continue;
      }
      if (run.status !== 'completed') {
        pending = true;
        continue;
      }
      if (run.conclusion !== 'success') {
        throw new Error(`${workflowName} for ${sourceCommit} finished with ${run.conclusion}.`);
      }
    }
    if (!pending) return runs;
    console.log('Waiting for all platform builds to finish...');
    await sleep(15_000);
  }
  throw new Error(`Timed out waiting for platform builds for ${sourceCommit}.`);
}

async function downloadArtifact(runId, artifactName, destination) {
  const data = await github(`/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`);
  const artifact = data.artifacts.find(candidate => candidate.name === artifactName && !candidate.expired);
  if (!artifact) throw new Error(`Artifact ${artifactName} was not found for run ${runId}.`);
  const response = await fetch(artifact.archive_download_url, { headers });
  if (!response.ok) throw new Error(`Artifact download failed (${response.status}) for ${artifactName}.`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function filesWithExtension(directory, extension) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesWithExtension(entryPath, extension));
    else if (entry.name.toLowerCase().endsWith(extension.toLowerCase())) found.push(entryPath);
  }
  return found;
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const version = packageJson.version;
const temporaryRoot = path.join(process.env.RUNNER_TEMP || process.cwd(), `sirverdata-downloads-${sourceCommit}`);
const stageDir = `${targetDir}.staging-${sourceCommit}`;

await rm(temporaryRoot, { recursive: true, force: true });
await rm(stageDir, { recursive: true, force: true });
await mkdir(temporaryRoot, { recursive: true });
await mkdir(stageDir, { recursive: true });

try {
  const runs = await waitForSuccessfulBuilds();
  const manifest = {
    product: 'SirverData',
    version,
    sourceCommit,
    generatedAt: new Date().toISOString(),
    files: {},
  };

  for (const [workflowName, config] of Object.entries(requiredWorkflows)) {
    const archivePath = path.join(temporaryRoot, `${workflowName.replaceAll(/[^a-z0-9]+/gi, '-')}.zip`);
    const extractDir = path.join(temporaryRoot, workflowName.replaceAll(/[^a-z0-9]+/gi, '-'));
    await downloadArtifact(runs.get(workflowName).id, config.artifact, archivePath);
    await mkdir(extractDir, { recursive: true });
    await execFileAsync('unzip', ['-q', archivePath, '-d', extractDir]);

    if (config.extension) {
      const candidates = await filesWithExtension(extractDir, config.extension);
      if (!candidates.length) throw new Error(`No ${config.extension} file found in ${config.artifact}.`);
      const filename = config.filename(version);
      await writeFile(path.join(stageDir, filename), await readFile(candidates[0]));
      manifest.files[filename] = `/downloads/${filename}`;
    } else {
      for (const [extension, filenameForVersion] of Object.entries(config.filenames)) {
        const candidates = await filesWithExtension(extractDir, extension);
        if (!candidates.length) throw new Error(`No ${extension} file found in ${config.artifact}.`);
        const filename = filenameForVersion(version);
        await writeFile(path.join(stageDir, filename), await readFile(candidates[0]));
        manifest.files[filename] = `/downloads/${filename}`;
      }
    }
  }

  await writeFile(path.join(stageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(targetDir, { recursive: true, force: true });
  await rename(stageDir, targetDir);
  console.log(`Published ${Object.keys(manifest.files).length} version ${version} downloads to ${targetDir}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  await rm(stageDir, { recursive: true, force: true });
}
