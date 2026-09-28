import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function nativeBuildEnvironment() {
  const env = { ...process.env };
  // Homebrew CocoaPods and a user-installed CocoaPods can use different Ruby
  // ABIs. Prefer the Ruby installation that owns GEM_HOME so native gems such
  // as nkf are never loaded by an incompatible Ruby after a directory change.
  const bins = [env.GEM_HOME && `${env.GEM_HOME}/bin`, env.RUBY_ROOT && `${env.RUBY_ROOT}/bin`]
    .filter((path) => path && existsSync(path));
  if (bins.length) env.PATH = `${bins.join(':')}:${env.PATH ?? ''}`;
  return env;
}

const buildEnvironment = nativeBuildEnvironment();
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: buildEnvironment,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runWithRetry(command, args, attempts, options = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(command, args, {
      cwd: projectRoot,
      env: buildEnvironment,
      stdio: 'inherit',
      ...options,
    });
    if (!result.error && result.status === 0) return;
    if (attempt < attempts) {
      console.warn(`Device install connection was interrupted; retrying (${attempt + 1}/${attempts})…`);
    } else {
      if (result.error) throw result.error;
      process.exit(result.status ?? 1);
    }
  }
}

const devices = spawnSync('xcrun', ['devicectl', 'list', 'devices'], { encoding: 'utf8', env: buildEnvironment });
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

const deviceId = physical[0].match(/[0-9A-F]{8}-[0-9A-F]{16}/i)?.[0];
if (!deviceId) {
  console.error(`Could not read the physical iPhone identifier from:\n${physical[0]}`);
  process.exit(1);
}

console.log(`Physical device found:\n${physical.join('\n')}`);
console.log('Building, signing, installing and launching Text Me on your iPhone…');

// Expo CLI currently asks Xcode 27 for Simulator.app even for a physical
// --device build. Perform the same native steps directly so this path never
// depends on a simulator being installed.
run('pod', ['install'], { cwd: `${projectRoot}/ios` });

const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
  encoding: 'utf8',
  env: buildEnvironment,
});
const selectedTeam = spawnSync(
  'defaults',
  ['read', 'com.apple.dt.Xcode', 'IDEProvisioningTeamManagerLastSelectedTeamID'],
  { encoding: 'utf8', env: buildEnvironment },
).stdout?.trim();
const developmentTeam = selectedTeam?.match(/^[A-Z0-9]{10}$/)?.[0]
  ?? identities.stdout?.match(/Apple Development:.*\(([A-Z0-9]{10})\)/)?.[1];
if (!developmentTeam) {
  console.error('No Apple Development signing identity was found. Add your Apple ID in Xcode → Settings → Accounts.');
  process.exit(1);
}

run('xcodebuild', [
  '-workspace', 'ios/TextMe.xcworkspace',
  '-scheme', 'TextMe',
  '-configuration', 'Release',
  '-destination', `id=${deviceId}`,
  '-derivedDataPath', 'ios/build-device',
  '-allowProvisioningUpdates',
  '-allowProvisioningDeviceRegistration',
  `DEVELOPMENT_TEAM=${developmentTeam}`,
  'CODE_SIGN_STYLE=Automatic',
  'build',
]);

const app = `${projectRoot}/ios/build-device/Build/Products/Release-iphoneos/TextMe.app`;
runWithRetry('xcrun', [
  'devicectl', 'device', 'install', 'app', '--device', deviceId, '--timeout', '180', app,
], 3);
run('xcrun', [
  'devicectl', 'device', 'process', 'launch', '--device', deviceId,
  '--terminate-existing', 'app.textme.owner',
]);
console.log('Text Me is installed and running on your iPhone.');
