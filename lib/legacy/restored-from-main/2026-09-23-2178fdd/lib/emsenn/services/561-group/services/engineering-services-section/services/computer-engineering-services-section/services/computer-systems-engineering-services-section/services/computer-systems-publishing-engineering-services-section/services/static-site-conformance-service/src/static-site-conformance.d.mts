export type ArtifactBody = string | Uint8Array;
export type ArtifactRecord = Readonly<{ body: ArtifactBody; mediaType?: string; cacheControl?: unknown; provenance?: unknown }>;
export type ArtifactInventory = Iterable<readonly [string, ArtifactBody | ArtifactRecord] | Readonly<{ path: string; body: ArtifactBody; mediaType?: string; cacheControl?: unknown; provenance?: unknown }>>;
export type WebReleaseArtifact = Readonly<{ path: string; url: string; bytes: number; digest: string; mediaType?: string; cacheControl?: unknown; provenance?: unknown }>;
export type WebReleaseManifest = Readonly<{
  kind: 'web-release-manifest'; version: 1; baseUrl: string; profile: string;
  exclusions: readonly string[]; artifactCount: number; byteCount: number;
  metadata: Readonly<Record<string, unknown>>; artifacts: readonly WebReleaseArtifact[]; digest: string;
}>;

export type ConformanceDiagnostic = Readonly<{ severity: 'error'; code: string; message: string; subject: string; target?: string }>;
export type HtmlLink = Readonly<{ tag: string; attribute: string; raw: string; url?: string; kind: 'internal' | 'external' | 'canonical-origin-escape' | 'unsafe' }>;

export function extractHtmlLinks(html: string, options: Readonly<{ documentUrl: string; canonicalOrigin?: string }>): Readonly<{
  documentUrl: string; baseUrl: string; links: readonly HtmlLink[]; diagnostics: readonly ConformanceDiagnostic[];
}>;

export function checkStaticSiteInventory(options: Readonly<{
  artifacts: ArtifactInventory; manifest: WebReleaseManifest; deliveryBaseUrl?: string; canonicalOrigin?: string; runtimePaths?: readonly string[];
}>): Readonly<{
  kind: 'static-site-inventory-conformance'; version: 1; manifestDigest: string; deliveryBaseUrl: string;
  canonicalOrigin: string; documentCount: number; linkCount: number; valid: boolean;
  diagnostics: readonly ConformanceDiagnostic[]; documents: readonly unknown[];
}>;

export type RemoteProbe = Readonly<{
  path: string; url: string; finalUrl: string; status: number; mediaType: string; bytes: number;
  digest: string; redirects: readonly string[]; exact: boolean; diagnostics: readonly ConformanceDiagnostic[];
}>;

export type RuntimeProbe = Readonly<{
  path: string; url: string; finalUrl: string; status: number; mediaType: string; bytes: number;
  digest: string; healthStatus: 'pass' | 'warn' | 'fail' | null; redirects: readonly string[];
  passed: boolean; diagnostics: readonly ConformanceDiagnostic[];
}>;

export function probeStaticSiteRelease(options: Readonly<{
  manifest: WebReleaseManifest; origin?: string; fetch?: typeof globalThis.fetch; fetchImpl?: typeof globalThis.fetch;
  includePaths?: readonly string[]; probePaths?: readonly string[]; maxRedirects?: number; concurrency?: number;
  maxBytes?: number; timeoutMilliseconds?: number; headers?: Readonly<Record<string, string>>;
  expectedHeaders?: Readonly<Record<string, string | RegExp>>;
}>): Promise<Readonly<{
  kind: 'static-site-remote-conformance'; version: 1; manifestDigest: string; origin: string;
  routeCount: number; exactCount: number; probeCount: number; valid: boolean; passed: boolean;
  diagnostics: readonly ConformanceDiagnostic[]; probes: readonly RemoteProbe[]; runtimeProbes: readonly RuntimeProbe[];
}>>;
