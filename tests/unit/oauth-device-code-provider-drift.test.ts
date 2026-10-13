import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * #14212 regression guard: every OAuth provider whose `flowType` is
 * "device_code" MUST be listed in OAuthModal.tsx's `DEVICE_CODE_PROVIDERS`.
 *
 * The bug this locks: WorkBuddy ships a full backend device-code flow
 * (src/lib/oauth/providers/workbuddy.ts, registered in providers/index.ts and
 * in the API route's NO_PKCE_DEVICE_CODE_PROVIDERS) but was missing from the
 * modal's hardcoded Set. startOAuthFlow then fell through to the
 * browser-authorize branch; generateAuthData() correctly answers `authUrl:
 * null` for device_code providers, and the modal turned that into
 * "Browser OAuth is unavailable for this provider in the current environment"
 * — a message that blames the environment for what is really a missing
 * client-side registration. The backend was green, CI was green, only the UI
 * was broken.
 *
 * Two independent lists are reconciled here, so the guard fires whenever they
 * drift in either direction:
 *
 *   1. Each provider module's own `flowType: "device_code"` declaration
 *      (source-level, so a module can be added without touching this test).
 *   2. The `device_code` entries in the PROVIDERS registry map (source-level,
 *      catching a module that is registered under a new key).
 *
 * Source inspection rather than importing the modules: OAuthModal.tsx is a
 * "use client" component with heavy runtime deps (next-intl, popup/fetch
 * orchestration), so reading it is the lightweight, reliable check — the same
 * approach as oauth-modal-grok-cli-browser-login-7013.test.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const modal = readFileSync(resolve(repoRoot, "src/shared/components/OAuthModal.tsx"), "utf8");
const registry = readFileSync(resolve(repoRoot, "src/lib/oauth/providers/index.ts"), "utf8");

/** `kimi-coding.ts` is bound in the registry as `kimiCoding`, etc. */
function toCamelCase(name: string): string {
  return name.replace(/-+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Providers declaring `flowType: "device_code"` in their own module, as the
 * camelCase binding name the registry imports them under.
 */
function deviceCodeModules(): string[] {
  const dir = resolve(repoRoot, "src/lib/oauth/providers");
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ts") || entry === "index.ts") continue;
    const source = readFileSync(resolve(dir, entry), "utf8");
    // Anchored on the exported provider object's flowType, not any incidental
    // mention of the string in a comment or a grant_type literal.
    if (/flowType:\s*"device_code"/.test(source)) {
      found.push(toCamelCase(entry.replace(/\.ts$/, "")));
    }
  }
  return found.sort();
}

/** Keys in the PROVIDERS map that are bound to a device_code module. */
function registryDeviceCodeKeys(modules: string[]): string[] {
  const map = registry.match(/export const PROVIDERS = \{([\s\S]*?)\n\};/);
  assert.ok(map, "expected to find the PROVIDERS map in providers/index.ts");

  const keys: string[] = [];
  for (const line of map![1].split("\n")) {
    const stripped = line.replace(/\/\/.*$/, "").trim();
    if (!stripped || stripped.startsWith("/*") || stripped.startsWith("*")) continue;
    // Matches both `name,` (shorthand) and `"key": name,`.
    const m = stripped.match(/^(?:"([^"]+)"|([A-Za-z0-9_]+))(?::\s*([A-Za-z0-9_]+))?,?$/);
    if (!m) continue;
    const key = m[1] ?? m[2];
    const binding = m[3] ?? m[2];
    if (key && binding && modules.includes(binding)) keys.push(key);
  }
  return keys.sort();
}

function extractSet(constName: string): string[] {
  const match = modal.match(new RegExp(`const ${constName} = new Set\\(\\[([^\\]]*)\\]\\)`));
  assert.ok(match, `expected to find ${constName} in OAuthModal.tsx`);
  // Strip line comments so an entry's trailing explanation is not parsed as a value.
  const body = match![1].replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const modules = deviceCodeModules();
const registryKeys = registryDeviceCodeKeys(modules);
const modalSet = extractSet("DEVICE_CODE_PROVIDERS");

test("the device-code census is non-empty (guards a silently broken parser)", () => {
  assert.ok(modules.length > 0, "expected at least one device_code provider module");
  // Sorted on both sides: array deepEqual is order-sensitive and the two lists
  // are maintained independently, so membership — not ordering — is the contract.
  assert.deepEqual(
    [...registryKeys].sort(),
    [...modalSet].sort(),
    "the device_code providers in the registry and in DEVICE_CODE_PROVIDERS should be the same set"
  );
});

test("every device_code provider is routed to the device-code panel (#14212)", () => {
  for (const providerId of registryKeys) {
    assert.ok(
      modalSet.includes(providerId),
      `device_code provider "${providerId}" is missing from DEVICE_CODE_PROVIDERS in ` +
        `OAuthModal.tsx. Without it startOAuthFlow falls through to the browser-authorize ` +
        `branch, which returns authUrl: null for device_code providers, and the modal shows ` +
        `"Browser OAuth is unavailable" instead of the device-code panel.`
    );
  }
});

test("workbuddy is routed to the device-code panel (the #14212 fix)", () => {
  assert.ok(modules.includes("workbuddy"), "workbuddy module must declare flowType device_code");
  assert.ok(modalSet.includes("workbuddy"), "workbuddy must be in DEVICE_CODE_PROVIDERS");
});

test("DEVICE_CODE_PROVIDERS lists no provider that is not device_code", () => {
  for (const providerId of modalSet) {
    assert.ok(
      registryKeys.includes(providerId),
      `DEVICE_CODE_PROVIDERS lists "${providerId}", but no provider with that key declares ` +
        `flowType: "device_code". A stale entry opens a device-code panel that the backend ` +
        `rejects with "Provider does not support device code flow".`
    );
  }
});
