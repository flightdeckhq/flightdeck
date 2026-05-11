# TypeScript and React guidelines

## Hard rules

- No `any`. Use `unknown` and narrow with type guards. The only exception is interop with a typed-poorly third-party module, where you wrap the boundary once and provide a typed surface to the rest of the codebase.
- `tsconfig.json` is in strict mode. `strict: true`, `noImplicitAny: true`, `strictNullChecks: true`, `noUncheckedIndexedAccess: true`. If the project's tsconfig is looser, that is a finding.
- No magic strings or magic numbers. Use module-level `const` declarations or string-literal union types. For related values use a `const` object with `as const` or a string-literal union, not a TypeScript `enum` (TS enums have runtime cost and produce surprising emit).
- Named exports. Default exports lose type information at the import site and break refactor tooling. The only exception is when a framework requires default export (Next.js page files, etc.).
- No `// @ts-ignore` without an explanation comment on the next line and a tracked issue. Prefer `// @ts-expect-error` so the suppression breaks if the underlying type fixes itself.
- `Promise` rejection is handled at every async call site. Either `await` inside a `try / catch`, chain `.catch`, or document why the rejection is silently safe.
- Module imports are explicit. No `import * as X from "y"` unless the namespace is the API. No barrel files that re-export everything (they break tree-shaking).
- One component per file when components are non-trivial.

## Idiomatic TypeScript

- Use `interface` for object shapes that may be extended, `type` for unions, intersections, and mapped types. Be consistent inside a project.
- Prefer discriminated unions over optional flags for variant types: `type Result = { ok: true; value: T } | { ok: false; error: E }`.
- `readonly` everywhere it is true. `readonly T[]` for input arrays you don't mutate. `Readonly<T>` for object inputs.
- `as const` to lock literal types when you want narrow inference: `const ROLES = ["admin", "user"] as const`.
- Generics for reusable code, but only when the genericity is real. A function that takes one concrete type does not need a generic.
- Type predicates (`function isFoo(x: unknown): x is Foo`) instead of casts.
- `satisfies` operator over type assertions for config-shaped objects: `const cfg = { ... } satisfies Config` keeps the literal type while validating the shape.

## React patterns

- Hooks rules are non-negotiable: top level only, never inside conditionals, loops, or nested functions. The eslint-plugin-react-hooks rule is on.
- `useEffect` dependency arrays are exhaustive. Suppressing the lint to silence a "missing dep" warning is almost always wrong; either the dep belongs in the array or the effect should not depend on it.
- One `useEffect` per concern. An effect that does three unrelated things is three effects.
- Derive, don't store. If a state value can be computed from props or other state, compute it during render or with `useMemo`. Don't `useState` + `useEffect` to sync.
- `key` prop on every list item. Use a stable id, not the array index, unless the list is truly static.
- Avoid `useMemo` and `useCallback` until profiling shows a re-render problem. They have a cost and the wrong dep array makes them stale.
- Controlled components for forms. Uncontrolled refs only for integration with non-React libraries.
- State colocated with the component that owns it. Lift state only when two siblings actually need to share it. Don't put everything in a global store.
- Server state (data from the network) lives in a query library (TanStack Query, SWR, RTK Query) or a server-state-aware framework, not in `useState`. Manual `useEffect` + `fetch` is a smell.

## State management

- Local component state: `useState` and `useReducer`.
- Cross-component shared state: a small store (Zustand, Jotai) or React context (for low-frequency updates only — context is not optimized for high-frequency state).
- Server state: a query library, never duplicated into client state.
- Don't use Redux unless the project's complexity actually warrants it. For most apps it is over-architected.

## CSS and styling

- One styling approach per project. Pick utility CSS (Tailwind), CSS-in-JS, CSS modules, or vanilla CSS files, and stick to it. Mixing them is a maintenance trap.
- Theme tokens via CSS custom properties. A `--color-bg` referenced in components keeps theme switching cheap and correct.
- Avoid hardcoded colors and spacing values in components. Reference the token: `bg-[var(--color-bg)]` or `var(--space-4)`.
- Component libraries (shadcn/ui, Radix primitives) are fine when the project chose them; mixing several is not. Pick one and use it consistently.
- Accessibility primitives (Radix, Headless UI) for any interactive component that involves focus traps, dialogs, dropdowns. Roll-your-own a11y is almost always wrong.

## Accessibility

- Every interactive element has an accessible name. `aria-label` when the visible name is missing or insufficient (e.g. icon-only buttons).
- Keyboard navigation works on every interactive surface. Tab order, focus visibility, Enter/Space activation, Escape to close.
- Color is not the sole indicator of state. Pair color with text, an icon, or a pattern.
- Semantic HTML first. `<button>` for actions, `<a href>` for navigation. Don't reach for `<div onClick>`.
- Headings are a tree (`h1 → h2 → h3`), not a typographic styling tool.
- Form inputs have associated `<label>` elements.
- Run `axe-core` or `eslint-plugin-jsx-a11y` in CI.

## Error handling

- Errors thrown at boundaries (network, parse, validation), caught at the rendering layer that can act on them (an error boundary, a toast notifier, a redirect).
- Don't swallow errors silently. Log them, surface them to the user, or both.
- React error boundaries around suspense boundaries and risky third-party components.
- Async actions in stores or query mutations expose loading, error, and success states explicitly. The component renders all three.

## Async and concurrency

- `await` in async functions. Don't `.then()` chain inside an `async` function.
- `Promise.all` for parallel work, `Promise.allSettled` when you want results regardless of individual failure.
- AbortController on every fetch that may be cancelled (component unmount, query refetch). Without abort, navigation away from a slow page leaves orphan requests.
- Timeouts on every network call. The browser's default fetch has none.
- Don't race promises by sequence-of-arrival when order matters. Use a token, a sequence number, or a query library that handles this.

## Performance

- Profile before optimizing. React DevTools profiler, Chrome performance tab.
- Component-level memoization (React.memo, useMemo, useCallback) is the last lever, not the first.
- Avoid heavy work in render. Move it to a `useMemo` or push it to a worker.
- Virtualize long lists (react-window, tanstack-virtual) when item counts exceed a few hundred.
- Code-split routes (`React.lazy`, dynamic import). Don't ship the admin panel to users who never open it.
- Bundle analyzer in CI. Surface size regressions on PR.

## Security

- Never `dangerouslySetInnerHTML` with user content unless it has been sanitized through a known-good library (DOMPurify).
- No `eval`, no `new Function(...)`. Treat the existence of either as a red flag.
- URLs constructed from user input go through `new URL()` and validation, not string concatenation.
- Secrets never reach the client bundle. Build-time env vars are visible to anyone who downloads the JS.
- CSP headers in the framework config when possible. Inline scripts and inline styles are blocked by default.
- Validate at trust boundaries. Don't assume the API returns the schema you expect; parse with Zod / Valibot / io-ts.

## Testing

- Vitest or Jest for unit tests. Vitest is faster and more ESM-friendly; Jest has more legacy ecosystem. Either is fine.
- React Testing Library for component tests. Query by accessible role first (`getByRole`), then label, then test id. CSS classes and text content are last resorts.
- Don't test implementation. Test behavior. A test that breaks when the component refactors but the rendered output is unchanged is a bad test.
- MSW (Mock Service Worker) for HTTP mocking in component tests. It runs against the same fetch path the production code uses.
- Playwright for E2E. Each test is independent (no shared state), seeds its own data via API, and asserts user-visible outcomes.
- No `await page.waitForTimeout(ms)`. Use Playwright's auto-waiting assertions: `await expect(locator).toBeVisible()`.
- Snapshot tests sparingly. They drift, get rubber-stamped, and lose meaning.

## Banned patterns

- `var` (use `const` and `let`).
- `let` when `const` would do.
- `==` and `!=` (use `===` and `!==`).
- `Function`, `Object`, `Number`, `String`, `Boolean` as types (use `() => void`, `object`, `number`, `string`, `boolean`).
- React class components in new code. Function components plus hooks have been the standard since 2019.
- `useEffect` to fetch data when a query library is available.
- `fetch` without a timeout or abort.
- DOM manipulation outside React refs (no `document.querySelector` in component code).
- Direct mutation of state (`state.items.push(x)`). Always return a new value.
- Inline arrow functions as `useEffect` deps or comparison props (creates a new identity each render).
- `setTimeout(0)` to "wait for the next tick". Use `queueMicrotask` if you really mean it, or rethink the design.
- IIFE wrapping in modern code (modules already give you a scope).
- Importing CSS in component files when the project uses utility CSS or CSS-in-JS.

## Project-specific notes

Flightdeck conventions (see `CLAUDE.md`):

- **Component library (rule 13).** shadcn/ui and custom components only.
  Never MUI, Ant Design, or Chakra UI. New UI primitives extend the
  existing shadcn/ui set; don't introduce a second component library.
- **Theme parity (rule 14).** Both `neon-dark` and `clean-light` themes
  must work at all times. After any frontend change verify both themes
  render correctly. Breaking one theme is an incomplete task. Never
  casually edit `globals.css` or `themes.css` — those define both themes
  and require explicit supervisor approval before editing (rule 15).
- **D3 math-only (rule 16).** In the timeline component, D3 is used
  exclusively for `d3-scale` and `d3-time` calculations. D3 must never
  manipulate the DOM. React owns the rendered tree.
- **No placeholder UI (rule 17).** Features that aren't ready don't
  appear in the UI. No grey boxes, no "coming soon" panels, no disabled
  stubs.
- **E2E discipline (rules 40c / 40c.1–4).** UI-touching tasks add
  Playwright tests at `dashboard/tests/e2e/`, named
  `Tnn-<kebab-case-journey>.spec.ts`, one journey per file. Tests run
  under both `neon-dark` and `clean-light` Playwright projects;
  assertions are theme-agnostic (no hardcoded colours). No fixed
  timeouts in tests — only polling (`expect.poll`, web-first
  assertions, `waitForFunction`). After UI edits run `npm run
  test:e2e` against a fresh dev stack before committing.
- **Pre-push lint (rule 40e).** Run `npm run lint` and `npm run
  typecheck` from `dashboard/` before pushing. CI enforces both.

