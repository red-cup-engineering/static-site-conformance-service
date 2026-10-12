# Static Site Conformance Service

`@red-cup-engineering/static-site-conformance-service` checks completed static
site releases without owning rendering, deployment credentials, or product
policy. It consumes the version 1 manifest emitted by
`@red-cup-engineering/web-release-candidate-service`.

```js
import { checkStaticSiteInventory, probeStaticSiteRelease } from
  "@red-cup-engineering/static-site-conformance-service";

const local = checkStaticSiteInventory({ artifacts, manifest });
const remote = await probeStaticSiteRelease({
  manifest,
  origin: "https://candidate.example/",
  fetchImpl: fetch,
  maxRedirects: 5,
});
```

## Local inventory conformance

`extractHtmlLinks(html, { documentUrl, canonicalOrigin })` resolves the URL
attributes used by ordinary navigation and page resources. It distinguishes
internal, external, origin escape, and unsafe references. HTTP(S),
`mailto:`, and `tel:` references are admitted; control characters,
credentials, malformed URLs, and active/local schemes are refused.

`checkStaticSiteInventory({ artifacts, manifest, deliveryBaseUrl,
canonicalOrigin, runtimePaths })` checks all manifest HTML. Internal URLs must name a
manifest artifact. `index.html` and `section/index.html` provide `/`,
`/section/`, `/section`, and their explicit index paths, matching ordinary
directory-index serving. Query strings do not alter artifact identity.
Supplying a preview `deliveryBaseUrl` exposes absolute links that escape back
to the origin. `runtimePaths` explicitly admits same-origin routes
served by composed dynamic applications, such as Webmention or Micropub
endpoints, without pretending they are static artifacts.

## Remote release conformance

`probeStaticSiteRelease` rebases manifest routes onto an optional candidate
origin and compares status, normalized media type, byte count, and SHA-256 NI
digest. Redirects are followed manually only within the candidate origin and
only up to the configured bound. `fetch`/`fetchImpl`, route selection, request
headers, expected response headers, redirect limit, response-byte limit,
timeout, and concurrency are injectable. `probePaths` adds bounded runtime
observations such as `/readyz`; probes require a 2xx response and also fail when
an `application/health+json` or JSON document reports `status: "fail"`. The service contains no
Cloudflare, Koios, editorial, advertising, or cutover rules.

The thin CLI keeps the same boundary and emits JSON suitable for a provider
staging script. It exits 0 for conformance, 1 for a completed failing probe, or
2 for an invalid invocation:

```sh
probe-static-site-release --manifest release-manifest.json \
  --origin https://candidate.example/ --probe /readyz
```

The intended VICTOR seam is after all projectors finish: create the release
manifest, run the local inventory check, write the candidate, then let a
provider preview it and run the remote probe against that same manifest.

Run `npm run check && npm test && npm pack --dry-run` for syntax, behavioral tests, and package-content checks.
