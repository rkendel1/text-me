import type {
  MacMessagesAdapter,
  ObservedMessagesMessage,
} from './mac-messages-adapter.js';

/**
 * The small surface expected from Photon iMessage Kit. Keeping this client
 * injected prevents Photon-specific APIs from leaking into the domain.
 */
export interface PhotonIMessageKitClient {
  sendMessage(input: { recipient: string; body: string }): Promise<{ requestId?: string }>;
  watch(handler: (message: ObservedMessagesMessage) => Promise<void>): Promise<() => Promise<void>>;
}

export class PhotonIMessageKitAdapter implements MacMessagesAdapter {
  constructor(private readonly client: PhotonIMessageKitClient) {}

  async send(input: { recipient: string; body: string }): Promise<{ providerRequestId?: string }> {
    const result = await this.client.sendMessage(input);
    return { providerRequestId: result.requestId };
  }

  watch(
    handler: (message: ObservedMessagesMessage) => Promise<void>,
  ): Promise<() => Promise<void>> {
    return this.client.watch(handler);
  }
}
