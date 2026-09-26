import type { AudioInput, SpeechProvider, Transcript } from './provider.js';

export class FakeSpeechProvider implements SpeechProvider {
  readonly name = 'fake';

  constructor(private readonly transcripts: Record<string, string> = {}) {}

  async transcribe(input: AudioInput): Promise<Transcript> {
    const text =
      typeof input.audio === 'string'
        ? input.audio
        : this.transcripts[input.callbackId] ?? '';

    return { text, callbackId: input.callbackId };
  }
}
