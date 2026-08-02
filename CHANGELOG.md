# Changelog

Generated automatically from conventional commits.

## [0.7.1](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.7.0...v0.7.1) (2026-08-02)

### Bug Fixes

* **registry:** keep server.json within the registry's field limits ([30e6877](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/30e687755e916a688047a7f4d17cb4047678ae9e))

## [0.7.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.6.0...v0.7.0) (2026-08-02)

### Features

* **distribution:** ship a Claude Code plugin and register with MCP ([762ebac](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/762ebacb964b413d43ceab40aa425323caad1c6f))

## [0.6.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.5.0...v0.6.0) (2026-08-02)

### Features

* **assert:** prove results without a screenshot ([5ce8852](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/5ce885269677df6870c3a702a9c489c9f65ff231))
* **context:** report declared, runtime and contradicting project state ([e3705c2](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/e3705c2992f2a552fc3d81e6d66ca93f19dcbf95))
* **determinism:** control the clock and the network from inside ([168d53b](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/168d53b2785f386b8d68d5519316c08e45d7778c))
* **flow:** record actions with the consequences they caused ([01673a8](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/01673a84d85a05ef9ae968d74d9bd7f9a9e29708))
* **native,a11y,build:** close the remaining loops ([9bd5acd](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/9bd5acdb5934c961a7a0de60d2bb0eaf206ebbb7))
* **preview,state:** mount components in situ and write app state ([dd52e20](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/dd52e20afbf11f444c46b687c387ecb4eb739ef1))
* **session:** persist runs and export them as one correlated artifact ([fe51f07](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/fe51f07e5199feaf6a31432309849c9548b816d0))
* **source:** put the source location on the tree and on the bus ([f0162c5](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/f0162c5568dbda99136bd5fddfe7a7835f887e20))
* **visual:** explain a visual regression instead of scoring it ([31f6a1f](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/31f6a1f38242a35612ec17b7752200df40b80cff))

### Bug Fixes

* **server:** give slow device commands their own timeout budget ([be7802e](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/be7802e6098f51425cf783aa6d3d8c0a30c52b1c))

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
