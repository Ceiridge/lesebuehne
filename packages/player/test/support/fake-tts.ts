import type { SpeechPort, UtteranceRequest } from '../../src/engine/speech-port.ts';
import type { VoiceInfo } from '../../src/engine/voices.ts';

/** A fake TTS (B12): records utterances; tests fire their events by hand. */
export class FakeTTS implements SpeechPort {
  readonly spoken: UtteranceRequest[] = [];
  cancels = 0;

  speak(request: UtteranceRequest): void {
    this.spoken.push(request);
  }
  cancel(): void {
    this.cancels++;
  }
  get last(): UtteranceRequest {
    const r = this.spoken.at(-1);
    if (!r) throw new Error('nothing spoken');
    return r;
  }
  get texts(): string[] {
    return this.spoken.map((r) => r.text);
  }
  /** Start the last utterance, fire a word boundary at every word, then end it. */
  speakLast(withWords = true): void {
    const r = this.last;
    r.onStart();
    if (withWords) for (const m of r.text.matchAll(/[\p{L}\p{N}]+/gu)) r.onBoundary(m.index ?? 0, 'word');
    r.onEnd();
  }
  /** Speak utterances until `n` were spoken or nothing new arrives. */
  run(n: number, withWords = true): void {
    for (let k = 0; k < n; k++) {
      const before = this.spoken.length;
      this.speakLast(withWords);
      if (this.spoken.length === before) return;
    }
  }
}

export const voice = (voiceURI: string, lang: string, localService = true, isDefault = false): VoiceInfo => ({
  voiceURI,
  name: voiceURI,
  lang,
  localService,
  default: isDefault,
});
