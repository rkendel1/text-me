import { spawnSync } from 'node:child_process';

const devices = spawnSync('xcrun', ['devicectl', 'list', 'devices'], { encoding: 'utf8' });
if (devices.status !== 0) {
  console.error(devices.stderr || 'Xcode could not list connected devices.');
  process.exit(devices.status || 1);
}

const physical = devices.stdout.split('\n').filter((line) => /connected/i.test(line) && !/simulated/i.test(line));
if (!physical.length) {
  console.error(`No physical iPhone is connected to Xcode.

1. Connect your unlocked iPhone to this Mac with USB.
2. Tap Trust on the iPhone if prompted.
3. Turn on Settings → Privacy & Security → Developer Mode.
4. Run npm run ios:device again.

This command intentionally never falls back to a simulator.`);
  process.exit(1);
}

console.log(`Physical device found:\n${physical.join('\n')}`);
console.log('Building, signing, installing and launching Text Me on your iPhone…');
const build = spawnSync('npx', ['expo', 'run:ios', '--device', '--configuration', 'Release'], {
  cwd: new URL('..', import.meta.url),
  env: process.env,
  stdio: 'inherit',
});
process.exit(build.status ?? 1);
