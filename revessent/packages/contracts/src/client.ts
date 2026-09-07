import { demoMode } from "@revessent/config";
import type { ApiClient } from "./api";
import { getMockApi } from "./mock/mockApi";
import { createRealApi } from "./real/realClient";

/**
 * The demo/real boundary (brief §10/§23).
 *
 * - Demo mode (explicit env opt-in, never in production): the labeled mock
 *   client + DemoBar; fixtures only.
 * - Real mode: the fetch client against /api/v1. If server env is missing,
 *   packages/config fails at boot — this module never falls back silently.
 */
export function getApi(): ApiClient {
  if (demoMode()) return getMockApi();
  return createRealApi();
}
