## Plan: Subpath-Only Exports (No Default Import)

**Strategy:**

- Block default import from "lifecycleion" with helpful error message ✅
- Add subpath export for each lib in package.json (e.g., "lifecycleion/arrays")
- Update tsup.config.ts with multiple entry points
- Each lib gets its own doc in docs/ folder
- Main README lists all libs with import paths and links to docs

**TODO:**

- [x] Inventory all libs (27 total)
- [x] Create error-throwing default export
- [ ] Complete all 27 libs (see checklist below)
- [ ] Write actual package.json description and keywords
- [ ] Update isPlainObject reference in lifecycle-manager.md
- [ ] Final verification: test all imports work correctly

## Libs to Export (27 total)

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

- [ ] **9. id-helpers.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/id-helpers.md
  - [ ] README mention

- [ ] **10. is-function.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/is-function.md
  - [ ] README mention

- [ ] **11. is-number.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/is-number.md
  - [ ] README mention

- [ ] **12. is-promise.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/is-promise.md
  - [ ] README mention

- [ ] **13. json-helpers.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/json-helpers.md
  - [ ] README mention

- [ ] **14. lifecycle-manager**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/lifecycle-manager.md
  - [ ] README mention

- [ ] **15. logger**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/logger.md
  - [ ] README mention

- [ ] **16. padding-utils.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/padding-utils.md
  - [ ] README mention

- [ ] **17. process-signal-manager.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/process-signal-manager.md
  - [ ] README mention

- [ ] **18. promise-protected-resolver.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/promise-protected-resolver.md
  - [ ] README mention

- [ ] **19. retry-utils**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/retry-utils.md
  - [ ] README mention

- [ ] **20. safe-handle-callback.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/safe-handle-callback.md
  - [ ] README mention

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

- [ ] **26. type-utils.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/type-utils.md
  - [ ] README mention

- [ ] **27. unix-time-helpers.ts**
  - [ ] package.json export
  - [ ] tsup entry
  - [ ] docs/unix-time-helpers.md
  - [ ] README mention
