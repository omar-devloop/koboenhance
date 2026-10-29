/**
 * types/chrome.d.ts — minimal ambient declarations for the extension APIs
 * KoboEnhance uses.
 *
 * The project deliberately avoids @types/chrome: tsconfig.json sets
 * "types": [], so these declarations are the only Chrome API surface. They cover
 * exactly the surface we call, and are intentionally narrow: if something is
 * added here it should be because real code needs it.
 *
 * The runtime message shape is intentionally `unknown`-friendly — Chrome
 * serialises runtime messages as JSON, so anything crossing the boundary is
 * untrusted and must be validated at runtime (see core/transfer/transport.sw.ts).
 */

interface KeChromeMessageSender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { id?: number; url?: string };
}

type KeChromeMessageListener = (
  message: unknown,
  sender: KeChromeMessageSender,
  sendResponse: (response?: unknown) => void
) => boolean | undefined;

interface KeChromeEvent<T extends (...args: never[]) => void> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
}

interface KeChromeRuntime {
  id?: string;
  lastError?: { message?: string };
  onMessage: KeChromeEvent<KeChromeMessageListener>;
  onInstalled: KeChromeEvent<KeChromeInstalledDetails>;
  sendMessage(message: unknown, callback?: (response: unknown) => void): void;
  getURL(path: string): string;
  getManifest(): { version: string } & Record<string, unknown>;
}

interface KeChromeInstalledDetails {
  reason: string;
  previousVersion?: string;
}

/** Promise-based subset of chrome.storage. `session` is memory-backed and is
 *  cleared when the browser closes, which is why destination API tokens live
 *  there rather than in localStorage. */
interface KeChromeStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface KeChromeStorage {
  session: KeChromeStorageArea;
  local: KeChromeStorageArea;
  sync: KeChromeStorageArea;
}

declare const chrome: {
  runtime: KeChromeRuntime;
  storage: KeChromeStorage;
};
