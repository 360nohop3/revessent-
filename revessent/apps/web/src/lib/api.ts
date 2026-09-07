import { getApi, ApiError, type MockApi, type ApiClient } from "@revessent/contracts";

export { ApiError };

/**
 * Single api handle for the app.
 *  - Demo mode: the labeled mock client, demo namespace included (DemoBar etc.).
 *  - Real mode: the /api/v1 fetch client — same interface, no demo namespace.
 * Components that use demo controls run only in demo mode and guard via `api.demo`.
 */
export const api = getApi() as ApiClient & { demo?: MockApi["demo"] };
