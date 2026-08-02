import puppeteer from "@cloudflare/puppeteer";
import { createCloudflareDiscoveryWorker } from "./main.js";
import { createUnifiedWorkerRouter } from "./static-router.js";

export {
  PublisherTranscriptAuthorizationDurableObject,
  YouTubeQuotaDurableObject,
} from "./main.js";

export default {
  async fetch(request, environment) {
    const routed = createUnifiedWorkerRouter({
      assets: environment.ASSETS,
      createApiWorker: () =>
        createCloudflareDiscoveryWorker(environment, {
          fetch: globalThis.fetch,
          now: () => new Date(),
          subtle: globalThis.crypto.subtle,
          randomBytes: (length) =>
            globalThis.crypto.getRandomValues(new Uint8Array(length)),
          browserLauncher: {
            limits: (binding) => puppeteer.limits(binding),
            launch: (binding) => puppeteer.launch(binding),
          },
        }),
    });
    if (routed.ok) return routed.value.fetch(request);
    return new Response(
      JSON.stringify({
        error: routed.error.kind,
        field: routed.error.field,
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  },
};
