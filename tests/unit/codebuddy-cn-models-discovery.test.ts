import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROVIDER_MODELS_CONFIG } from "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts";
import { getDiscoveryClass } from "../../src/lib/providerModels/discoveryClass.ts";
import { providerUsesCuratedModelsOnly } from "../../src/lib/providers/modelListingCapability.ts";

/**
 * Both CodeBuddy gateways publish a live catalogue, contrary to what the
 * curated-model list used to assert. Verified live (2026-10-14):
 *   CN   GET copilot.tencent.com/console/enterprises/personal/models -> 200, 32
 *        entries, 31 usable for chat (one media-only model filtered)
 *   intl GET www.codebuddy.ai/v3/config                             -> 200, 28
 *        entries, 26 usable for chat
 * The curated registries carried 16 and 22 respectively, and being classified
 * `static-only` is what hid the dashboard's "Import Models" button.
 *
 * The two gateways do NOT share an endpoint: intl's /console/enterprises path
 * 500s from the edge under every header combination tried.
 */
describe("codebuddy-cn model discovery", () => {
  it("is no longer curated-only, so the dashboard offers model import", () => {
    assert.equal(
      providerUsesCuratedModelsOnly("codebuddy-cn"),
      false,
      "codebuddy-cn must be discoverable — its gateway serves a live catalogue"
    );
    assert.equal(getDiscoveryClass("codebuddy-cn"), "openai-compat");
  });

  it("reads the roster from the CN gateway's enterprise endpoint", () => {
    const config = PROVIDER_MODELS_CONFIG["codebuddy-cn"];
    assert.ok(config, "codebuddy-cn must have a discovery entry");
    assert.equal(config.url, "https://copilot.tencent.com/console/enterprises/personal/models");
    assert.equal(config.method, "GET");
    assert.equal(config.authHeader, "Authorization");
    assert.equal(config.authPrefix, "Bearer ");
    assert.equal(config.headers["X-Product"], "SaaS");
    // The gateway's edge rejects/impoverishes requests without a known client
    // UA, and the CN realm wants the codebuddy.cn origin.
    assert.ok(config.headers["User-Agent"], "must send a User-Agent");
    assert.equal(config.headers["Origin"], "https://www.codebuddy.cn");
  });

  it("discovers codebuddy-intl too, but from /v3/config rather than the enterprise path", () => {
    assert.equal(
      providerUsesCuratedModelsOnly("codebuddy-intl"),
      false,
      "intl also serves a live catalogue; only its /console route is dead"
    );
    assert.equal(getDiscoveryClass("codebuddy-intl"), "openai-compat");

    const config = PROVIDER_MODELS_CONFIG["codebuddy-intl"];
    assert.ok(config, "codebuddy-intl must have a discovery entry");
    assert.equal(config.url, "https://www.codebuddy.ai/v3/config");
    assert.equal(config.method, "GET");
    assert.equal(config.authHeader, "Authorization");
    assert.equal(config.authPrefix, "Bearer ");
    assert.equal(config.headers["X-Product"], "SaaS");
    // The roster is UA-dependent: the desktop shape yields 26 chat models, the
    // CLI shape only 20, and the registry's IDE shape none. Pin the desktop one.
    assert.equal(config.headers["User-Agent"], "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1");
    assert.equal(config.headers["Origin"], "https://www.codebuddy.ai");
  });

  it("maps the catalogue to ids and names, dropping media-only models", () => {
    const payload = {
      code: 0,
      msg: "OK",
      requestId: "abc",
      data: {
        models: [
          { id: "glm-5.3", name: "GLM-5.3", tags: ["craft"] },
          { id: "kimi-k2.6", name: "Kimi-K2.6", tags: [] },
          // Image generation: media and nothing else, so unusable for chat.
          { id: "hunyuan-image-alpha", name: "Hunyuan Image", tags: ["text-to-image"] },
          // Untagged entries are kept.
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        ],
      },
    };
    const models = PROVIDER_MODELS_CONFIG["codebuddy-cn"].parseResponse(payload) as Array<{
      id: string;
      name: string;
      owned_by: string;
    }>;

    assert.deepEqual(
      models.map((m) => m.id),
      ["glm-5.3", "kimi-k2.6", "deepseek-v4-pro"]
    );
    assert.equal(models[0].name, "GLM-5.3");
    assert.equal(models[0].owned_by, "codebuddy");
  });

  it("keeps a model whose tags are not exclusively media", () => {
    const payload = {
      code: 0,
      data: {
        models: [
          { id: "mixed", name: "Mixed", tags: ["craft", "text-to-image"] },
          { id: "video", name: "Video", tags: ["text-to-video"] },
        ],
      },
    };
    const models = PROVIDER_MODELS_CONFIG["codebuddy-cn"].parseResponse(payload) as Array<{
      id: string;
    }>;
    assert.deepEqual(
      models.map((m) => m.id),
      ["mixed"]
    );
  });

  it("falls back to the id when no name is present, and drops entries without an id", () => {
    const payload = { data: { models: [{ id: "no-name" }, { name: "orphan" }] } };
    const models = PROVIDER_MODELS_CONFIG["codebuddy-cn"].parseResponse(payload) as Array<{
      id: string;
      name: string;
    }>;
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "no-name");
    assert.equal(models[0].name, "no-name");
  });
});
