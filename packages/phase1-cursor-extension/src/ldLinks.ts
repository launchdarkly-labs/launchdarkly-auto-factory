/**
 * Deep links into the LaunchDarkly app for resources the chain created. The URL
 * shapes are taken from LaunchDarkly's own API (`_site.href` for metrics, the
 * audit log's `site` href for flags), so they match what the app uses.
 *
 * The app host is the same as the API host for SaaS (`LD_BASE_URL`, default
 * app.launchdarkly.com). On a custom/federal instance where they differ, set
 * LD_BASE_URL to the app host.
 */

export interface ResourceLink {
  key: string;
  url: string;
}

export interface CreatedLinks {
  flag?: ResourceLink;
  metrics: ResourceLink[];
}

function appBaseUrl(): string {
  return (process.env.LD_BASE_URL || "https://app.launchdarkly.com").replace(/\/+$/, "");
}

export function flagUrl(project: string, flagKey: string): string {
  return `${appBaseUrl()}/${project}/~/features/${encodeURIComponent(flagKey)}`;
}

export function metricUrl(project: string, metricKey: string): string {
  return `${appBaseUrl()}/${project}/metrics/${encodeURIComponent(metricKey)}/details`;
}

/**
 * Build links from the created-resource inventory (WalkResult.inventory) — the
 * never-rewound record, so a loop rewind can't erase links to resources that
 * really exist.
 */
export function buildCreatedLinks(project: string, inventory: Record<string, string>): CreatedLinks {
  const links: CreatedLinks = { metrics: [] };
  if (inventory.flag_key) links.flag = { key: inventory.flag_key, url: flagUrl(project, inventory.flag_key) };
  if (inventory.metric_keys) {
    for (const key of inventory.metric_keys.split(",").map((k) => k.trim()).filter(Boolean)) {
      links.metrics.push({ key, url: metricUrl(project, key) });
    }
  }
  return links;
}
