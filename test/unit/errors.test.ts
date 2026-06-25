import { expect, test } from "vitest";
import { Hono } from "hono";
import { ApiError, onError, parseAddress, normalizeAddress } from "../../src/api/lib/errors";

function appThatThrows(err: unknown): Hono {
  const app = new Hono();
  app.onError(onError);
  app.get("/boom", () => {
    throw err;
  });
  return app;
}

test("ApiError renders as an RFC 9457 problem at its status", async () => {
  const res = await appThatThrows(new ApiError("invalid_address", 400, "bad address")).request(
    "/boom",
  );
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect(await res.json()).toEqual({
    type: "/docs#errors-invalid_address",
    code: "invalid_address",
    title: "Invalid address",
    status: 400,
    detail: "bad address",
  });
});

test("unexpected errors render as a 500 internal problem", async () => {
  const res = await appThatThrows(new Error("kaboom")).request("/boom");
  expect(res.status).toBe(500);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect(await res.json()).toEqual({
    type: "/docs#errors-internal",
    code: "internal",
    title: "Internal server error",
    status: 500,
    detail: "Internal server error",
  });
});

test("parseAddress lowercases a valid checksummed address", () => {
  expect(parseAddress("0x52908400098527886E0F7030069857D2E4169EE7")).toBe(
    "0x52908400098527886e0f7030069857d2e4169ee7",
  );
});

test("parseAddress rejects a malformed address", () => {
  expect(() => parseAddress("0xnope")).toThrow(ApiError);
});

test("parseAddress rejects a missing address", () => {
  expect(() => parseAddress(undefined)).toThrow(ApiError);
});

test("normalizeAddress lowercases an already-validated address", () => {
  expect(normalizeAddress("0xAbCdEf0000000000000000000000000000000001")).toBe(
    "0xabcdef0000000000000000000000000000000001",
  );
});
