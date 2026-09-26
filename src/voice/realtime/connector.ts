import {
  createGateway,
  type Experimental_RealtimeClientEvent as RealtimeClientEvent,
  type Experimental_RealtimeServerEvent as RealtimeServerEvent,
  type Experimental_RealtimeSessionConfig as RealtimeSessionConfig,
} from 'ai';
import WebSocket from 'ws';

export type { RealtimeClientEvent, RealtimeServerEvent, RealtimeSessionConfig };

export interface RealtimeConnectionHandlers {
  onEvent(event: RealtimeServerEvent): void;
  onClose(reason: string): void;
}

export interface RealtimeConnection {
  send(event: RealtimeClientEvent): Promise<void>;
  close(): void;
}

/** Opens a realtime model session. Swappable so the call bridge can be tested offline. */
export interface RealtimeConnector {
  readonly modelId: string;
  connect(config: RealtimeSessionConfig, handlers: RealtimeConnectionHandlers): Promise<RealtimeConnection>;
}

export interface GatewayRealtimeConnectorOptions {
  modelId: string;
  /** Defaults to AI_GATEWAY_API_KEY, then Vercel OIDC, exactly like the AI SDK. */
  apiKey?: string;
  /** Override the Gateway origin, e.g. for a local stand-in during testing. */
  baseURL?: string;
  teamIdOrSlug?: string;
}

/**
 * Server-side realtime session through the Vercel AI Gateway.
 *
 * Uses the AI SDK's Gateway realtime model for everything protocol-specific
 * (client-secret minting, WebSocket URL and auth subprotocols, event codec),
 * so the same code works for any upstream the Gateway supports.
 */
export class GatewayRealtimeConnector implements RealtimeConnector {
  readonly modelId: string;
  private readonly gateway: ReturnType<typeof createGateway>;

  constructor(options: GatewayRealtimeConnectorOptions) {
    this.modelId = options.modelId;
    this.gateway = createGateway({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      teamIdOrSlug: options.teamIdOrSlug,
    });
  }

  async connect(config: RealtimeSessionConfig, handlers: RealtimeConnectionHandlers): Promise<RealtimeConnection> {
    const token = await this.gateway.experimental_realtime.getToken({
      model: this.modelId,
      expiresAfterSeconds: 60,
    });
    const model = this.gateway.experimental_realtime(this.modelId);
    const target = model.getWebSocketConfig
      ? model.getWebSocketConfig({ token: token.token, url: token.url })
      : { url: token.url, protocols: undefined };
    const parse = model.createServerEventParser?.() ?? ((raw: unknown) => model.parseServerEvent(raw));
    const socket = new WebSocket(target.url, target.protocols);

    const send = async (event: RealtimeClientEvent): Promise<void> => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const serialized = await model.serializeClientEvent(event);
      socket.send(typeof serialized === 'string' ? serialized : JSON.stringify(serialized));
    };

    socket.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = parse(raw);
      for (const event of Array.isArray(parsed) ? parsed : [parsed]) handlers.onEvent(event);
    });
    socket.on('close', (_code, reason) => handlers.onClose(reason.toString() || 'closed'));

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.on('error', (error) => handlers.onClose(error.message));
    await send({
      type: model.capabilities?.startup ?? 'session-update',
      config: model.buildSessionConfig(config) as RealtimeSessionConfig,
    });

    return {
      send,
      close: () => socket.close(),
    };
  }
}
