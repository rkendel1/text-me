import type { AudioOutput, VoiceProvider } from './provider.js';

export class FakeVoiceProvider implements VoiceProvider {
  readonly name = 'fake';
  readonly outputs: AudioOutput[] = [];

  async speak(text: string): Promise<AudioOutput> {
    const output = { provider: this.name, text, audio: text };
    this.outputs.push(output);
    return output;
  }
}
