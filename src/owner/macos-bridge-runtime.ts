import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { FileOwnerBridgeCheckpointStore } from './bridge.js';
import { FileBridgeStateStore, MacBridgeAgent } from './bridge-agent.js';
import { startConnectServer } from './bridge-connect-server.js';
import { PhotonIMessageKitAdapter, type PhotonIMessageKitClient } from './photon-imessage-adapter.js';
import { createPhotonKitClient } from './photon-kit-client.js';

const BRIDGE_VERSION = '1.0.0';

/**
 * The Mac bridge. There is nothing to configure: run it, scan the code shown
 * on the iPhone, and everything else follows from the owner's settings.
 */
async function main(): Promise<void> {
  const dataDir = process.env.MAC_BRIDGE_DATA_DIR ?? (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Attn Bridge')
    : join(homedir(), '.attn-bridge'));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const agent = new MacBridgeAgent({
    adapter: new PhotonIMessageKitAdapter(await loadClient()),
    store: new FileBridgeStateStore(join(dataDir, 'device.json')),
    checkpoint: new FileOwnerBridgeCheckpointStore(join(dataDir, 'checkpoint.json')),
    bridgeVersion: BRIDGE_VERSION,
    log: (message, error) => console.error(message, error instanceof Error ? error.message : error ?? ''),
  });
  await agent.start();

  const page = await startConnectServer(agent, Number(process.env.MAC_BRIDGE_PORT ?? 0));
  let opened = false;
  const showConnectPage = () => {
    console.log(`Connect this Mac: ${page.url}`);
    if (process.platform === 'darwin') execFile('open', [page.url], () => undefined);
    opened = true;
  };
  if (agent.status().phase !== 'connected') showConnectPage();
  // Revoked from the iPhone: bring the scanner back so the owner can reconnect.
  agent.onChange(() => {
    const { phase } = agent.status();
    if (phase === 'waiting_for_qr' && !opened) showConnectPage();
    if (phase === 'connected') opened = false;
  });

  const stop = async () => {
    await agent.stop();
    await page.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (true) {
    await agent.tick();
    await sleep(5000);
  }
}

async function loadClient(): Promise<PhotonIMessageKitClient> {
  // For development only: substitute a Messages client module.
  const override = process.env.PHOTON_CLIENT_MODULE;
  if (!override) return createPhotonKitClient();
  const loaded = await import(resolve(override));
  if (typeof loaded.createPhotonClient === 'function') return loaded.createPhotonClient();
  if (typeof loaded.default === 'function') return new loaded.default();
  return loaded.default as PhotonIMessageKitClient;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
