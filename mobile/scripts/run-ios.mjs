import { existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const projectRoot = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

function simulator() {
  const runtimes = JSON.parse(output('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])).devices;
  const devices = Object.values(runtimes).flat().filter((device) => device.isAvailable && device.name.startsWith('iPhone'));
  let selected = devices.find((device) => device.state === 'Booted');
  if (!selected) {
    selected = devices[0];
    if (!selected) throw new Error('No available iPhone simulator runtime is installed in Xcode.');
    console.log(`Booting ${selected.name}…`);
    run('xcrun', ['simctl', 'boot', selected.udid]);
    run('xcrun', ['simctl', 'bootstatus', selected.udid, '-b']);
  }
  return selected;
}

function podEnvironment() {
  const env = { ...process.env };
  try {
    const pods = output('brew', ['--prefix', 'cocoapods']);
    const rubyGemsRoot = `${output('brew', ['--prefix', 'ruby'])}/lib/ruby/gems`;
    const rubyVersion = existsSync(rubyGemsRoot) ? readdirSync(rubyGemsRoot).sort().at(-1) : undefined;
    if (rubyVersion) env.GEM_PATH = `${pods}/libexec:${rubyGemsRoot}/${rubyVersion}`;
  } catch {
    // A working `pod` outside Homebrew needs no override.
  }
  return env;
}

async function metroIsRunning() {
  try {
    const response = await fetch('http://127.0.0.1:8081/status', { signal: AbortSignal.timeout(1000) });
    return (await response.text()).includes('packager-status:running');
  } catch {
    return false;
  }
}

const device = simulator();
console.log(`Using ${device.name} (${device.udid})`);

if (!existsSync(`${projectRoot}/ios/TextMe.xcworkspace`)) {
  run('npx', ['expo', 'prebuild', '--platform', 'ios']);
}
run('pod', ['install'], { cwd: `${projectRoot}/ios`, env: podEnvironment() });

let metro;
if (!(await metroIsRunning())) {
  metro = spawn('npx', ['expo', 'start', '--localhost', '--port', '8081'], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });
  for (let attempt = 0; attempt < 30 && !(await metroIsRunning()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!(await metroIsRunning())) throw new Error('Metro did not start on port 8081.');
} else {
  console.log('Using the Metro server already running on port 8081.');
}

run('xcodebuild', [
  '-quiet',
  '-workspace', 'ios/TextMe.xcworkspace',
  '-scheme', 'TextMe',
  '-configuration', 'Debug',
  '-destination', `platform=iOS Simulator,id=${device.udid}`,
  '-derivedDataPath', 'ios/build',
  'build',
]);

const app = 'ios/build/Build/Products/Debug-iphonesimulator/TextMe.app';
run('xcrun', ['simctl', 'install', device.udid, app]);
spawnSync('xcrun', ['simctl', 'terminate', device.udid, 'app.textme.owner'], { stdio: 'ignore' });
run('xcrun', ['simctl', 'launch', device.udid, 'app.textme.owner']);
console.log('Text Me is running. Press Ctrl+C to stop Metro.');

if (metro) {
  const stop = () => metro.kill('SIGINT');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise((resolve) => metro.once('exit', resolve));
}
