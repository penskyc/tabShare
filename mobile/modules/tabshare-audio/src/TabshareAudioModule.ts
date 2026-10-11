import { NativeModule, requireNativeModule } from 'expo';

type Events = {
  /** One engine -> page message, as JSON (same protocol as the desktop engine, see src/rig/native.ts). */
  onMessage(event: { json: string }): void;
};

declare class TabshareAudioModule extends NativeModule<Events> {
  send(json: string): void;
  getServerUrl(): string;
  setServerUrl(url: string): void;
}

export default requireNativeModule<TabshareAudioModule>('TabshareAudio');
