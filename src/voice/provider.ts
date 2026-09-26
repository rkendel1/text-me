export interface AudioOutput {
  provider: string;
  text: string;
  audio: unknown;
}

export interface VoiceProvider {
  readonly name: string;
  speak(text: string): Promise<AudioOutput>;
}
