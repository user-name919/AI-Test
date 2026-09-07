# Task 3 report: 基于真实 DOM 解析 Agent 测试数据

## Files changed

- `shared/contracts.ts`
- `shared/live-execution.ts`
- `server/test-data-binding.ts`
- `server/test-data-binding.test.ts`
- `server/test-policy.ts`
- `server/test-policy.test.ts`
- `server/test-agent.ts`
- `server/test-agent.test.ts`
- `server/single-action-executor.ts`
- `server/single-action-executor.test.ts`
- `server/responses-decision-provider.ts`
- `server/responses-decision-provider.test.ts`
- `server/live-execution.test.ts`

## RED

The required focused command was run before production implementation:

```sh
node --import tsx --test server/test-data-binding.test.ts server/test-policy.test.ts server/test-agent.test.ts server/single-action-executor.test.ts server/responses-decision-provider.test.ts
```

Result: **7 passed, 13 failed**. The new resolver test failed with `ERR_MODULE_NOT_FOUND` because `server/test-data-binding.ts` did not exist. The model-provider test rejected the unknown `resolve_test_data` decision. The policy tests showed that unknown `valueRef` and text-only highlighter assertions were incorrectly accepted. Browser-backed agent/executor tests also could not start in the restricted sandbox because Chromium exited with `SIGTRAP`; this was an environment permission limitation before their assertions ran.

## GREEN

After the minimal implementation, the exact required focused command was rerun in the approved non-sandboxed test environment:

```sh
node --import tsx --test server/test-data-binding.test.ts server/test-policy.test.ts server/test-agent.test.ts server/single-action-executor.test.ts server/responses-decision-provider.test.ts
```

Result: **22 passed, 0 failed**.

The complete Task 3 focused set, including live-execution wording, also passed:

```sh
node --import tsx --test --test-concurrency=1 server/test-data-binding.test.ts server/test-policy.test.ts server/test-agent.test.ts server/single-action-executor.test.ts server/responses-decision-provider.test.ts server/live-execution.test.ts
```

Result: **29 passed, 0 failed**.

Additional verification:

```sh
npm run typecheck
git diff --check
git diff --cached --check
```

All passed. The focused Node test commands emitted the existing `DEP0205` `module.register()` deprecation warning from the `tsx` setup; it did not affect outcomes.

## Commit

- `30d1f047a573571d23e80a33068e9d8310f2df4b` — `feat: 基于真实 DOM 解析 Agent 测试数据`

No push was performed.

## Review fix round 2 (2026-09-07)

### RED

Before changing production code, the two focused regression files were run:

```sh
node --import tsx --test --test-concurrency=1 server/test-data-binding.test.ts server/test-policy.test.ts
```

Result: **8 passed, 2 failed**. `resolveRuntimeDataBinding` accepted unchecked runtime bindings that omitted the strict visible-option protocol even when the source and proposed substring were otherwise valid. The highlighter policy's positive-term check also accepted negative states containing `highlight` or `match`.

### GREEN

The same focused regression command passed after the two minimal guards were added:

```sh
node --import tsx --test --test-concurrency=1 server/test-data-binding.test.ts server/test-policy.test.ts
```

Result: **10 passed, 0 failed**. The resolver now requires `visible_option_substring`, current-DOM origin, and strict-source-substring constraints defensively; highlighter evidence explicitly refuses `not-highlighted`, `unmatched`, `not-matched`, `未高亮`, and `未匹配` before evaluating allowed positive terms. `keyword-match` and `highlighted` remain accepted.

The complete Task 3 focused suite was then run in the approved non-sandboxed environment required for local Chromium:

```sh
node --import tsx --test --test-concurrency=1 server/test-data-binding.test.ts server/test-policy.test.ts server/test-agent.test.ts server/single-action-executor.test.ts server/responses-decision-provider.test.ts server/live-execution.test.ts
```

Result: **37 passed, 0 failed**. `npm run typecheck` also passed. The existing `DEP0205` `tsx` loader warning remained non-fatal.

## Self-review

- `resolve_test_data` is an internal Agent decision, validates the current snapshot and a visible option, does not call Playwright, and does not increment `executedSteps`.
- `visible_option_substring` preserves source text while accepting only a nonempty strict substring. Missing, hidden, stale, wrong-binding, fabricated, and full-source proposals become blocked test-data precondition failures.
- `fill`, `selectOption`, and `expectValue` validate exactly one of `value` or `valueRef`. The executor resolves only validated bindings; policy refuses unknown, unconfigured, or unresolved references.
- A binding carrying `mustRemainAfterFiltering` is rechecked after the `fill`; disappearance is classified as a product `failed` case, not a data-precondition block.
- Resolved binding evidence records the id, source element reference and text, value, source snapshot, observation timestamp, and reason in trajectory/result state. Live activity preserves a readable source/value description and technical decision detail.
- Highlighter assertions cannot be passed by generic visible text: they require current observable element attribute/state evidence. No CSS or arbitrary-script assertion mechanism was introduced.
- The optional goal `executionContract` is intentionally only protocol state for unit coverage. The current goal builder and runner were not connected or changed; Task 4 owns single-case server-resolved goal wiring.

## Concerns

- `TestAgentResult.resolvedDataBindings` is optional only to preserve the existing runner's pre-execution failure initializer without expanding this task into runner changes. A completed `TestAgent.run()` result always supplies the evidence array.
- Playwright requires the approved non-sandboxed environment on this host; restricted-sandbox Chromium startup fails before test code executes.

## Review fix round 1 (2026-09-03)

### Findings corrected

1. A raw `value` could bypass a runtime DOM binding. `TestPolicy` now rejects raw values whenever an execution contract has bindings unless the value exactly matches a fixture with evidence or a manual value with rationale. Legacy goals without an execution contract remain compatible, and fixture/manual values deliberately remain raw literals rather than fabricated DOM-backed `valueRef`s.
2. Runtime DOM bindings now require `visible_option_substring`, `mustComeFromCurrentDom: true`, and `mustBePartialOfSource: true` in the schema. The resolver always requires a visible `role="option"` source, including defensive calls that bypass schema parsing.
3. Post-filter source preservation now requires a visible option with the source text; a same-text button cannot satisfy the contract.
4. Highlighter assertions now allow only `expectAttribute` against `class` or `data-state`, and the asserted value must express highlight/match/mark/keyword semantics. The model prompt no longer suggests generic `aria-*` evidence.
5. A malformed candidate whose top-level type is `resolve_test_data` retains its data-domain classification. The Responses provider raises `RuntimeDataBindingBlockedError` after its bounded repairs, and TestAgent blocks both that error and direct malformed resolver candidates without executing a Playwright action. Malformed ordinary action candidates remain failed.

### RED

Before the fixes, the required focused command:

```sh
node --import tsx --test server/test-data-binding.test.ts server/test-policy.test.ts server/test-agent.test.ts server/single-action-executor.test.ts server/responses-decision-provider.test.ts
```

reported **19 passed, 9 failed**. The failures proved all reviewed gaps: raw runtime literal acceptance, missing runtime binding schema invariants, strategy-less non-option source acceptance, same-text non-option preservation, over-broad highlighter evidence, prompt `aria-*` guidance, and malformed `resolve_test_data` ending as ordinary failure instead of a blocked data condition.

### GREEN

Final complete Task 3 verification ran in the approved non-sandboxed environment:

```sh
node --import tsx --test --test-concurrency=1 server/test-data-binding.test.ts server/test-policy.test.ts server/test-agent.test.ts server/single-action-executor.test.ts server/responses-decision-provider.test.ts server/live-execution.test.ts
npm run typecheck
git diff --check
```

Result: **36 passed, 0 failed**; typecheck and diff check passed. The existing `DEP0205` `tsx` loader warning remained non-fatal.

### Review-fix commit

- `1d7204cb41e5119536c410349cd2b0d594a59fb0` — `fix: 加固真实 DOM 数据绑定约束`

No push was performed.
