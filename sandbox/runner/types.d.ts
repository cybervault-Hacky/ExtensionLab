declare module "chrome-remote-interface" {
  export interface TargetInfo {
    id: string;
    type: string;
    url: string;
    title?: string;
  }

  export interface NavigationEntry {
    id: number;
    url?: string;
  }

  export interface CdpClient {
    on(event: string, listener: (params: unknown) => void): void;
    close(): Promise<void>;
    Runtime: {
      enable(): Promise<unknown>;
      evaluate(input: { expression: string; returnByValue?: boolean }): Promise<{ result?: { value?: unknown } }>;
    };
    Page: {
      enable(): Promise<unknown>;
      navigate(input: { url: string }): Promise<{ frameId?: string }>;
      captureScreenshot(input?: { format?: string }): Promise<{ data: string }>;
      reload(input?: { ignoreCache?: boolean }): Promise<unknown>;
      getNavigationHistory(): Promise<{ currentIndex?: number; entries?: NavigationEntry[] }>;
      navigateToHistoryEntry(input: { entryId: number }): Promise<unknown>;
    };
    Network: {
      enable(): Promise<unknown>;
      clearBrowserCookies(): Promise<unknown>;
    };
    Log: {
      enable(): Promise<unknown>;
    };
    Storage: {
      clearDataForOrigin(input: { origin: string; storageTypes: string }): Promise<unknown>;
    };
    ServiceWorker: {
      enable(): Promise<unknown>;
    };
    Target: {
      setDiscoverTargets(input: { discover: boolean }): Promise<unknown>;
      getTargets(): Promise<{ targetInfos?: TargetInfo[] }>;
      createTarget(input: { url: string }): Promise<{ targetId?: string }>;
      closeTarget(input: { targetId: string }): Promise<unknown>;
    };
    Emulation: {
      setDeviceMetricsOverride(input: {
        width: number;
        height: number;
        deviceScaleFactor: number;
        mobile: boolean;
      }): Promise<unknown>;
    };
    Input: {
      dispatchMouseEvent(input: Record<string, unknown>): Promise<unknown>;
      dispatchKeyEvent(input: Record<string, unknown>): Promise<unknown>;
      insertText(input: { text: string }): Promise<unknown>;
    };
    Browser: {
      getVersion(): Promise<{ product?: string; version?: string }>;
    };
  }

  export default function CDP(input: { port: number; target: string }): Promise<CdpClient>;
  export function List(input: { port: number }): Promise<TargetInfo[]>;
}
