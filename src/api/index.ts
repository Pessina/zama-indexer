import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { balanceRoute, balanceHandler } from "./routes/balance";
import { transfersRoute, transfersHandler } from "./routes/transfers";
import { healthRoute, healthHandler } from "./routes/health";
import { onError, problem } from "./lib/errors";

// OpenAPIHono extends Hono, so Ponder serves it unchanged; documented routes go
// through `app.openapi(...)` (zod-validated, in the spec), undocumented ones via
// `app.get(...)`. A failed request-schema validation is rendered as a Problem.
const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const code = result.target === "param" ? "invalid_address" : "invalid_request";
      const detail = result.error.issues.map((i) => i.message).join("; ");
      return problem(c, code, 400, detail);
    }
    return undefined;
  },
});

app.onError(onError);
app.notFound((c) => problem(c, "not_found", 404, "Unknown route"));

// Transfer history (documented + validated).
app.openapi(transfersRoute, transfersHandler);

// Balance — reads live chain state (db-free), documented + validated.
app.openapi(balanceRoute, balanceHandler);

// Health — indexer sync lag (indexed checkpoint vs. chain head), documented + validated.
app.openapi(healthRoute, healthHandler);

// OpenAPI 3.1 spec + Swagger UI. The spec is the single source of "what to do per
// status/entitlement/error code"; responses carry only codes + data.
app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Zama Confidential ERC-7984 Indexer API",
    version: "1.0.0",
    description:
      "Clear-text read API over a confidential ERC-7984 token. Balances and transfer history with cleartext amounts where the indexer holds decryption rights; undecryptable amounts surface as an explicit status, never a wrong number or a silent drop.",
  },
});
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

export default app;
