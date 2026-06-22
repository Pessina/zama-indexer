// Unit tests for the decrypt error classifier (`classifyDecryptError`). Pure,
// deterministic, no chain: each case constructs a real SDK error instance (the
// oracle — not a mock) and asserts how the indexer would persist it. Fast via
// `pnpm test:unit`; also runs inside the full `pnpm test`.
//
// Scope: the branches the integration test (decrypt-seam.test.ts) can't produce on the
// cleartext stack — fatal misconfig, relayer-only codes, expired delegation, transient /
// unknown errors, and the silent-"pending" regression guard. The two common not-entitled
// paths (direct "not authorized", delegated DELEGATION_NOT_FOUND) are canaried against the
// real SDK there, so they're intentionally not re-asserted here.
import { describe, expect, test } from "vitest";
import {
  ChainMismatchError,
  ConfigurationError,
  DecryptionFailedError,
  DelegationExpiredError,
  DelegationNotPropagatedError,
  NoCiphertextError,
  RelayerRequestFailedError,
  SignerNotConfiguredError,
  ZamaError,
  ZamaErrorCode,
} from "@zama-fhe/sdk";

import { classifyDecryptError } from "../../src/utils/zama";

describe("classifyDecryptError", () => {
  // ── Fatal misconfiguration → rethrow (a wrong chain / missing signer can't be
  // fixed by a retry or an ACL grant, so it must surface, not mis-park rows). ──
  describe("fatal codes rethrow", () => {
    test("CHAIN_MISMATCH rethrows", () => {
      const err = new ChainMismatchError({
        operation: "decryptValues",
        signerChainId: 11155111,
        providerChainId: 31337,
      });
      expect(() => classifyDecryptError(err)).toThrow(ChainMismatchError);
    });

    test("SIGNER_NOT_CONFIGURED rethrows", () => {
      expect(() => classifyDecryptError(new SignerNotConfiguredError("decryptValues"))).toThrow(
        SignerNotConfiguredError,
      );
    });

    test("CONFIGURATION rethrows", () => {
      expect(() => classifyDecryptError(new ConfigurationError("unsupported chain"))).toThrow(
        ConfigurationError,
      );
    });
  });

  // ── Not-entitled cases the integration test CAN'T reproduce on the cleartext stack.
  // (The common paths — direct "not authorized" and delegated DELEGATION_NOT_FOUND — are
  // exercised against the live SDK in decrypt-seam.test.ts.) These two can't be: the
  // per-handle "not delegated" string is only a rare fallback (the service pre-flight
  // catches the common delegated case via DELEGATION_NOT_FOUND first), and an EXPIRED
  // delegation can't be aged out in a fast test. ──
  describe("not-entitled (cases integration can't reproduce) → pending", () => {
    test("per-handle 'not delegated' cleartext string → pending", () => {
      const err = new DecryptionFailedError(
        "Encrypted value 0xabc is not delegated for user decryption",
      );
      expect(classifyDecryptError(err)).toEqual({ status: "pending", reason: "not-entitled" });
    });

    test("DELEGATION_EXPIRED → pending (delegation lapsed; wait for a re-grant)", () => {
      const err = new DelegationExpiredError("delegation for 0xToken has expired");
      expect(classifyDecryptError(err)).toEqual({
        status: "pending",
        reason: "delegation-expired",
      });
    });
  });

  // ── Recoverable → failed (the block sweep retries these). ──
  describe("recoverable → failed", () => {
    test("a DECRYPTION_FAILED that is NOT an entitlement message → decrypt-failed", () => {
      const err = new DecryptionFailedError("Decryption returned no value for 0xabc");
      expect(classifyDecryptError(err)).toEqual({ status: "failed", reason: "decrypt-failed" });
    });

    test("DELEGATION_NOT_PROPAGATED → failed (self-resolving; sweep retries, not a re-grant)", () => {
      const err = new DelegationNotPropagatedError("gateway not synced yet");
      expect(classifyDecryptError(err)).toEqual({
        status: "failed",
        reason: "delegation-not-propagated",
      });
    });

    test("RELAYER_REQUEST_FAILED → failed", () => {
      const err = new RelayerRequestFailedError("relayer error", 503);
      expect(classifyDecryptError(err)).toEqual({
        status: "failed",
        reason: "relayer-request-failed",
      });
    });

    test("NO_CIPHERTEXT → failed", () => {
      const err = new NoCiphertextError("no ciphertext for account");
      expect(classifyDecryptError(err)).toEqual({ status: "failed", reason: "no-ciphertext" });
    });
  });

  // ── Unknown / non-ZamaError → failed, NEVER a silent "pending". Regression
  // guard for the bug we fixed: a pending row only retries on a grant, so an
  // unknown error parked there would strand forever. ──
  describe("unknown → failed (never silent pending)", () => {
    test.each([
      "fetch failed",
      "ECONNRESET",
      "request timed out",
      "socket hang up",
      "502 Bad Gateway",
    ])("transient transport error %j → transient-network", (message) => {
      expect(classifyDecryptError(new Error(message))).toEqual({
        status: "failed",
        reason: "transient-network",
      });
    });

    test("a non-transient plain Error → failed with its raw message (NOT pending)", () => {
      expect(classifyDecryptError(new Error("boom"))).toEqual({ status: "failed", reason: "boom" });
    });

    test("an unmapped ZamaError code falls through to failed (only the 3 fatal codes throw)", () => {
      const err = new ZamaError(ZamaErrorCode.TransactionReverted, "tx reverted");
      expect(classifyDecryptError(err)).toEqual({ status: "failed", reason: "tx reverted" });
    });

    test("a non-Error thrown value → failed with String(value)", () => {
      expect(classifyDecryptError("weird string")).toEqual({
        status: "failed",
        reason: "weird string",
      });
    });
  });
});
