export interface AudioInput {
  callbackId: string;
  audio: unknown;
}

export interface Transcript {
  text: string;
  callbackId: string;
}

export interface SpeechProvider {
  readonly name: string;
  transcribe(input: AudioInput): Promise<Transcript>;
}
