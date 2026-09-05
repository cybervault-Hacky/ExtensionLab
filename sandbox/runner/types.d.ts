declare module "chrome-remote-interface" {
  export interface TargetInfo {
    id: string;
    type: string;
    url: string;
    title?: string;
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
    };
    Network: {
      enable(): Promise<unknown>;
    };
    Log: {
      enable(): Promise<unknown>;
    };
    ServiceWorker: {
      enable(): Promise<unknown>;
    };
    Target: {
      setDiscoverTargets(input: { discover: boolean }): Promise<unknown>;
    };
    Browser: {
      getVersion(): Promise<{ product?: string; version?: string }>;
    };
  }

  export default function CDP(input: { port: number; target: string }): Promise<CdpClient>;
  export function List(input: { port: number }): Promise<TargetInfo[]>;
}