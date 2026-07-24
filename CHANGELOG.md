# Changelog

Generated automatically from conventional commits.

## [0.5.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.4.0...v0.5.0) (2026-07-24)

### Features

* **server:** native device logs with dedup, in MCP and the dashboard ([b8c54d4](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/b8c54d4a9563572043c0c95d6ae250c21c4db8d5))

## [0.4.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.3.2...v0.4.0) (2026-07-24)

### Features

* **client:** role selectors, container scoping and typed action args ([d14b670](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/d14b670287de9c91505069db25471095612c9228))
* **server:** native adapter, superset of idb scripting for agents ([875c1ca](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/875c1ca31db5c72ab23e6a13b256c07e5908073f))

## [0.3.2](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.3.1...v0.3.2) (2026-07-23)

### Bug Fixes

* **client:** ui automation no longer sees screens the user left ([2f66f9c](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/2f66f9ca87335b429498c04aa4b935859d2008bf))

## [0.3.1](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.3.0...v0.3.1) (2026-07-23)

### Bug Fixes

* **dashboard:** keep expanded JSON nodes open in the network detail ([a9b3cd4](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/a9b3cd4eb93bd2716137c827d270bc4ced058140))
* **dashboard:** stop event-batch renders from resetting panel state ([5ad72d0](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/5ad72d00b84605f1f1e0f0b473ee7b9d90b1a9fe))

## [0.3.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.2.0...v0.3.0) (2026-07-22)

### Features

* **client:** runtime UI automation and screen-ready signal for agents ([ccadb61](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/ccadb61c7c8bc3869b777bf5763a04d0059d0823))
* **server:** agent MCP tools with event cursor and wait_for_event ([82f51d5](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/82f51d53ed4d6b9e9bb09d5fb076313ce8883812))

### Bug Fixes

* **dashboard:** identify each device's app and flag Design mismatches ([f038c4e](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/f038c4ecbdad7182616db3b7b7c516c4fd9aee66))

## [0.2.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.1.0...v0.2.0) (2026-07-20)

### Features

* **client:** export truncateForWire, redactHeaders and public types ([70ec514](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/70ec51456140ef2a139ccf6470bdf63c6bc55454))

### Bug Fixes

* **types:** resolve the client subpath under moduleResolution node ([8cacaf5](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/8cacaf5906bdc350ae8158928252d451744f9d06))

## 0.1.0 (2026-07-19)

### Features

* **cli:** add init codemod for zero-effort integration ([458865e](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/458865e25a8fb36e366234b475a06fc58d4fdfa2))
* initial release of rn-devtools-hub ([0849ce6](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/0849ce6335e83bdddb6d3bad567e455f3626814f))

### Bug Fixes

* **ci:** use Node 24 so npm ci reads the npm 11 lockfile ([06e5ce7](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/06e5ce7c7581b895b002a5222af9a556b1a1f633))

### Performance Improvements

* **mirror:** adaptive frame loop with burst after input ([1c75ad5](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/1c75ad56461b8b1f4a05281908b446f44e8abf8b))
