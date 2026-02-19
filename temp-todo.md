## Plan: Subpath-Only Exports (No Default Import)

**Strategy:**

- Block default import from "lifecycleion" with helpful error message ✅
- Add subpath export for each lib in package.json (e.g., "lifecycleion/arrays")
- Update tsup.config.ts with multiple entry points
- Each lib gets its own doc in docs/ folder
- Main README lists all libs with import paths and links to docs

**TODO:**

- [x] Inventory all libs (28 total, after splitting type-utils into is-boolean and is-plain-object)
- [x] Create error-throwing default export
- [ ] Complete all 28 libs (see checklist below)
- [ ] Write actual package.json description and keywords
- [x] Update isPlainObject reference in lifecycle-manager.md
- [ ] Final verification: test all imports work correctly

## Libs to Export (28 total)

For each lib, complete:

1. Add subpath export to package.json
2. Add entry point to tsup.config.ts
3. Create/move doc to docs/ folder
4. Add to main README table

---

- [x] **1. arrays.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/arrays.md
  - [x] README mention

- [x] **2. ascii-tables**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/ascii-tables.md
  - [x] README mention

- [x] **3. clamp.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/clamp.md
  - [x] README mention

- [x] **4. constants.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/constants.md
  - [x] README mention

- [x] **5. curly-brackets.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/curly-brackets.md
  - [x] README mention

- [x] **6. deep-clone.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/deep-clone.md
  - [x] README mention

- [x] **7. error-to-string.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/error-to-string.md
  - [x] README mention

- [x] **8. event-emitter.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/event-emitter.md
  - [x] README mention

- [x] **9. id-helpers.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/id-helpers.md
  - [x] README mention

- [x] **10. is-function.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/is-function.md
  - [x] README mention

- [x] **11. is-number.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/is-number.md
  - [x] README mention

- [x] **12. is-promise.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/is-promise.md
  - [x] README mention

- [x] **13. json-helpers.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/json-helpers.md
  - [x] README mention

- [x] **14. lifecycle-manager**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/lifecycle-manager.md
  - [x] README mention

- [x] **15. logger**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/logger.md
  - [x] README mention

- [x] **16. padding-utils.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/padding-utils.md
  - [x] README mention

- [x] **17. process-signal-manager.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/process-signal-manager.md
  - [x] README mention

- [x] **18. promise-protected-resolver.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/promise-protected-resolver.md
  - [x] README mention

- [x] **19. retry-utils**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/retry-utils.md
  - [x] README mention

- [x] **20. safe-handle-callback.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/safe-handle-callback.md
  - [x] README mention

- [ ] **21. serialize-error**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/serialize-error.md
  - [ ] README mention

- [ ] **22. single-event-observer.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/single-event-observer.md
  - [ ] README mention

- [ ] **23. sleep.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/sleep.md
  - [ ] README mention

- [ ] **24. strings.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/strings.md
  - [ ] README mention

- [ ] **25. tmp-dir.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/tmp-dir.md
  - [ ] README mention

- [x] **26. is-boolean.ts** _(split from type-utils)_
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/is-boolean.md
  - [x] README mention

- [x] **27. is-plain-object.ts** _(split from type-utils)_
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/is-plain-object.md
  - [x] README mention

- [x] **28. unix-time-helpers.ts**
  - [x] package.json export
  - [x] tsup entry
  - [x] docs/unix-time-helpers.md
  - [x] README mention
