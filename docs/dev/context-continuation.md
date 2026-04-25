# Agent Context Continuation

This document has been merged into `docs/dev/model-switching-design.md`.

The canonical implementation spec is:

- `docs/dev/model-switching-design.md`

Do not treat this file as a separate normative design source. It remains only as
a redirect for older links.

Merged topics include:

- native resume vs soft context injection;
- cross-SDK and same-pool provider-switch continuation;
- lightweight handoff injection source ordering and safety rules;
- soft injection message shape;
- runtime-aware session storage;
- native session invalidation by provider, model, and auth profile generation;
- scheduled-task continuation scope.

Current decision: HappyClaw does not implement a complete cross-runtime memory
authority for model switching. `CLAUDE.md` is loaded by each SDK's native
project-instruction mechanism. `/model use` first creates a bounded handoff
summary from recent HappyClaw DB messages, then the next turn injects that
summary only. Non-switch resume/recovery fallback may still use bounded recent
messages.
