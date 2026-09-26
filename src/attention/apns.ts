import { createPrivateKey, sign } from 'node:crypto';
import { connect, type ClientHttp2Session, type SecureClientSessionOptions } from 'node:http2';

import { attentionUrl, type OwnerAttention } from './model.js';

/**
 * Apple Push Notification service for the native iOS app. Token-based auth
 * (a .p8 key): an ES256 JWT signed with the key, reused for up to 50 minutes,
 * sent over HTTP/2 to Apple.
 */
export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 private key contents (PEM). */
  privateKey: string;
  bundleId: string;
  environment: 'production' | 'development';
  /** Tests only: send to this origin instead of Apple. */
  origin?: string;
  tls?: SecureClientSessionOptions;
}

export interface ApnsMessage {
  payload: Record<string, unknown>;
  priority: 10 | 5;
  /** Same id replaces an earlier notification on the device instead of adding another. */
  collapseId: string;
  expiresAt: Date;
}

export interface ApnsSender {
  readonly bundleId: string;
  send(deviceToken: string, message: ApnsMessage): Promise<{ apnsId?: string }>;
}

export class ApnsError extends Error {
  constructor(readonly statusCode: number, readonly reason: string) {
    super(`APNs ${statusCode} ${reason}`);
  }

  /** The device uninstalled the app or the token is no longer valid: stop sending to it. */
  get deviceGone(): boolean {
    return this.statusCode === 410 || (this.statusCode === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(this.reason));
  }
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export function apnsJwt(config: Pick<ApnsConfig, 'keyId' | 'teamId' | 'privateKey'>, issuedAt: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(issuedAt / 1000) }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${claims}.${base64url(signature)}`;
}

export class HttpApnsSender implements ApnsSender {
  private session?: ClientHttp2Session;
  private token?: { value: string; issuedAt: number };

  constructor(private readonly config: ApnsConfig, private readonly now: () => number = Date.now) {}

  get bundleId(): string {
    return this.config.bundleId;
  }

  private origin(): string {
    return this.config.origin ?? (this.config.environment === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com');
  }

  private authorization(): string {
    // Apple rejects tokens older than an hour and throttles refreshing more than every 20 minutes.
    if (!this.token || this.now() - this.token.issuedAt > 50 * 60 * 1000) {
      const issuedAt = this.now();
      this.token = { value: apnsJwt(this.config, issuedAt), issuedAt };
    }
    return `bearer ${this.token.value}`;
  }

  private connection(): ClientHttp2Session {
    if (!this.session || this.session.closed || this.session.destroyed) {
      this.session = connect(this.origin(), this.config.tls);
      this.session.on('error', () => { this.session = undefined; });
      this.session.on('goaway', () => { this.session = undefined; });
      this.session.unref();
    }
    return this.session;
  }

  send(deviceToken: string, message: ApnsMessage): Promise<{ apnsId?: string }> {
    const body = JSON.stringify(message.payload);
    return new Promise((resolve, reject) => {
      const stream = this.connection().request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: this.authorization(),
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': String(message.priority),
        'apns-collapse-id': message.collapseId.slice(0, 64),
        'apns-expiration': String(Math.floor(message.expiresAt.getTime() / 1000)),
        'content-type': 'application/json',
      });
      let status = 0;
      let apnsId: string | undefined;
      let data = '';
      stream.setEncoding('utf8');
      stream.on('response', (headers) => {
        status = Number(headers[':status']);
        apnsId = typeof headers['apns-id'] === 'string' ? headers['apns-id'] : undefined;
      });
      stream.on('data', (chunk) => { data += chunk; });
      stream.on('error', reject);
      stream.on('end', () => {
        if (status === 200) return resolve({ apnsId });
        let reason = 'Unknown';
        try { reason = (JSON.parse(data) as { reason?: string }).reason ?? reason; } catch { /* keep Unknown */ }
        reject(new ApnsError(status, reason));
      });
      stream.end(body);
    });
  }

  close(): void {
    this.session?.close();
  }
}

/**
 * The native notification: same title, body and deep link as Web Push, so a tap
 * lands on the same live conversation. Actions come from the app's
 * notification category; the tap itself always carries the intent.
 */
export function apnsMessage(attention: OwnerAttention, now: number = Date.now()): ApnsMessage {
  const interrupt = attention.priority === 'interrupt';
  const actionable = attention.actions.some((action) => action !== 'open');
  return {
    priority: interrupt ? 10 : 5,
    collapseId: attention.id,
    expiresAt: new Date(now + (interrupt ? 600 : 3600) * 1000),
    payload: {
      aps: {
        alert: { title: attention.title, body: attention.body.length > 180 ? `${attention.body.slice(0, 177)}…` : attention.body },
        ...(interrupt ? { sound: 'default', 'interruption-level': 'time-sensitive' } : { 'interruption-level': 'passive' }),
        'thread-id': attention.conversationId,
        ...(actionable ? { category: 'OWNER_ATTENTION' } : {}),
      },
      url: attentionUrl(attention),
      attentionId: attention.id,
      conversationId: attention.conversationId,
    },
  };
}

export function apnsConfigFromEnv(env: NodeJS.ProcessEnv): ApnsConfig | undefined {
  const { APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID } = env;
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_PRIVATE_KEY || !APNS_BUNDLE_ID) return undefined;
  return {
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
    // Vercel env vars often store the PEM with literal \n.
    privateKey: APNS_PRIVATE_KEY.replace(/\\n/g, '\n'),
    bundleId: APNS_BUNDLE_ID,
    environment: env.APNS_ENVIRONMENT === 'development' ? 'development' : 'production',
  };
}
