# DECISIONS

Design notes and trade-offs for the `zama-indexer` confidential ERC-7984 indexer. See `TASK.md` (workspace root) for the brief this responds to.

> Draft — sections are stubbed and will be filled in as the build progresses.

## Overview

_What this service is, in two sentences._

_TODO_

## What I composed vs. wrote myself

_The off-the-shelf primitives — indexing library (Ponder), the Zama SDK for decryption, the database, the HTTP server (Hono) — and why each was chosen. What was written by hand, and why._

_TODO_

## Key trade-offs

_Storage model, throttling against the relayer, and how the read API surfaces the awkward in-between states (amounts not yet decryptable). Where I would push back on the brief._

_TODO_

## Un-decryptable events & backfill

_How events the indexer cannot yet decrypt are persisted (encrypted handle + pending state) rather than dropped, and how cleartext is backfilled once an ACL delegation propagates._

_TODO_

## Reflection

### Least confident under partner load

_The one piece (a function, a callback, a chunk of the indexer config, an API handler) most likely to break first under load — what breaks, and how I would prove it._

_TODO_

### What I cut / the next four hours

_What was deliberately left out, and what I would do first with more time._

_TODO_

### SDK feedback

_Two or three concrete improvements to `@zama-fhe/sdk`. For each: (a) the concrete change, (b) the partner-integration scenario it unblocks, (c) its priority relative to the others._

1. _TODO — (a) change · (b) scenario unblocked · (c) priority_
2. _TODO_
3. _TODO_

### AI assistance

_Which tools were used and how; one place a tool produced something subtly wrong that had to be corrected._

_TODO_
