# Agent Note: Keep subprocess output alive when spill storage disappears

Status: implemented

English | [中文](2026-08-19-resilient-subprocess-output-spill.zh.md)

## Problem

`dsh-subprocess-local` keeps a bounded in-memory tail and optionally writes the complete stream to a private spill file. The operating system or an external cleanup tool can remove the private spill directory while a subprocess is still running. The next stream chunk that crosses the memory cap then raises `ENOENT` or `EPERM` from the spill write inside a stream callback, taking down the host instead of returning the diagnostic tail.

## Decision

`OutputCollector.push()` treats `ENOENT` and `EPERM` from `spillAll()` as loss of the optional spill layer. It calls the existing `discardSpill()` cleanup, disables further spilling for that stream, and continues the normal bounded-tail path. Other spill I/O errors still propagate, so unrelated storage failures are not hidden. Once spilling is disabled, `readFrom()` and `finalize()` expose only the in-memory result and do not advertise a missing spill path.

## Alternatives considered

**Recreate the directory and retry the spill.** Rejected because the original private directory is an externally owned cleanup target; recreating it would make the collector's path and permissions depend on a race, while the bounded tail already provides a safe degraded result.

**Replace the directory with a new temporary directory.** Rejected because an existing collector may already have a spill file or an open descriptor, and changing directories mid-stream would split one logical output across paths.

**Let every spill error propagate.** Rejected because spill storage is optional and a missing temp directory must not turn a running subprocess's output callback into an uncaught host failure. Non-`ENOENT`/`EPERM` errors remain propagating.

## Consequences

The complete output is unavailable after the spill directory is lost, but the last `maxBytes` remain available and the collector reports truncation as it does when spilling is not configured. A stream does not retry a failed spill, which avoids repeated callback failures and path races; a later stream or subprocess can create a fresh default spill directory when needed.

## Testing

`packages/subprocess/subprocess-local/tests/spawn.spec.ts` deletes the injected spill directory before the first overflow, asserts that pushing the next chunk does not throw, and verifies that finalization returns only the bounded tail without a stale spill path.
