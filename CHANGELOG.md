# Changelog

Generated automatically from conventional commits.

## [0.19.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.18.0...v0.19.0) (2026-09-02)

### Features

* **mcp:** improve agent onboarding contract ([e700f82](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/e700f822c24bc36fe4984edaaaa0edfb5583d0d3))

## [0.18.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.17.0...v0.18.0) (2026-08-30)

### Features

* **benchmark:** add reproducible bug-fix pilot runner ([44270a7](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/44270a75fbb443a316feadeb5cab4bd3434909e2))

### Bug Fixes

* **assert:** distinguish count saturation above bounds ([8de115d](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/8de115de42c7cc649be71955b80798b128b0308e))
* **hubflow:** attach native failures and isolate device runs ([b0625d2](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/b0625d2af537b4d40e412820ed3c28c9e1054e62))

## [0.17.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.16.0...v0.17.0) (2026-08-30)

### Features

* **assert:** prove how many elements a list rendered ([408483c](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/408483c89ea44999453696d3cb55b6e4a3e61e13))

### Bug Fixes

* **hub:** report the real package version in the MCP handshake ([efbeae8](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/efbeae8f3aa8c5f2d384f7d6fe7c1a29c365004e))

## [0.16.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.15.1...v0.16.0) (2026-08-29)

### Features

* **cli:** run Hubflow scenarios ([eace502](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/eace502461e17d78fbdf289d2ba78cf6bc39b777))
* **dashboard:** add the Hubflow tests workspace ([f0bfe62](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/f0bfe62689df6ea8d5348f3f1a0268761a9eebc4))
* **hub:** count what screenshots cost, and let them be switched off ([3a445ab](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/3a445ab460242b8802242f3ab0cddaeaf714746f))
* **hub:** drive App Store Connect and Google Play from the hub ([7c07b68](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/7c07b68f4e00ce14178a23b230f3bb50c9dc3df7))
* **hubflow:** add durable causal scenarios ([029914d](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/029914df554806d95aca85bcc940dda9e3c9bb7a))
* **hub:** regenerate and publish the store screenshots from the app ([63678cf](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/63678cf92e75357068bb8ca14c5ef2d97b03e62a))
* **plugins:** declare the vendor contract, and check it upstream ([c595cbb](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/c595cbb9a63541d9aa0cf36875ac2d47fbbf0194))

### Bug Fixes

* **flow:** bound and protect recordings ([20ad428](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/20ad428782b49492b637870fe00d6d35fb50d12b))
* **hubflow:** harden replay evidence ([8b64e1f](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/8b64e1f070e7ed27559829e135761a04c21564c6))

## [0.15.1](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.15.0...v0.15.1) (2026-08-15)

### Bug Fixes

* **sdk:** redact credentials in bodies, not just in four headers ([e774945](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/e774945cc3a746b8e0c5053ae7d39122d9502954))

## [0.15.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.14.0...v0.15.0) (2026-08-15)

### Features

* **overlay:** hide the dev-menu bubble from the agent, at runtime ([6ada400](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/6ada400cdab3cd60b131ffde308cb8d7ec540739))

## [0.14.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.13.1...v0.14.0) (2026-08-15)

### Features

* **hub:** run several projects at once, and stop dressing refusals as results ([1390a1c](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/1390a1ce7b328a7cbf03845de813f42e45250655))
* **native:** add swipe_native and hide the dev-menu bubble on launch ([5baecc1](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/5baecc155b1febc35dc591d2941d73b534124039))

### Bug Fixes

* **assert:** name the reason a verdict failed ([2e79610](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/2e796106555e1f17a4a9b60c55ce8065347af1df))
* **automation:** act on the element ui_act reports ([bf42222](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/bf42222f5f59726b850211313e1825100343c4df))
* **flow:** keep the index of a recorded ui_act ([a2cd162](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/a2cd162ffdc024809ec164e6a6e34ef628e38a72))

## [0.13.1](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.13.0...v0.13.1) (2026-08-08)

### Bug Fixes

* **native:** explain a broken idb instead of surfacing its traceback ([19431a5](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/19431a5403720cdd4f60bdfd5d0f5116b08f3f96))

## [0.13.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.12.3...v0.13.0) (2026-08-07)

### Features

* **dashboard:** add a Tools panel measuring what agents do with the hub ([f1b493a](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/f1b493a9d05469cd6534d83f7263570541ada75e))
* **mcp:** say when nothing is observable, not just that nothing was found ([edc0d53](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/edc0d5375ad5268a989a6199f0ba8600faa69213))

## [0.12.3](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.12.2...v0.12.3) (2026-08-02)

### Bug Fixes

* **sdk:** keep binary events whole instead of relying on the caller ([b5d8bb1](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/b5d8bb152190e25751a8dcd079dbb63bed52475e))

## [0.12.2](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.12.1...v0.12.2) (2026-08-02)

### Bug Fixes

* **ui_act:** actually raise the keyboard, and trust frames over declarations ([37ba2be](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/37ba2be02902c7b51f5c399739b558829366f364))

## [0.12.1](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.12.0...v0.12.1) (2026-08-02)

## [0.12.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.11.7...v0.12.0) (2026-08-02)

### Features

* **context:** name the capabilities a project has not enabled ([5560cd8](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/5560cd8a4ef8e50f0d130d3a8c849b0fd99f7a33))
* **ui_act:** add focus and blur, and say why a device cannot be mirrored ([4ddc94f](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/4ddc94fe0ad480b4428feafad2853e98cf062d6e))

## [0.11.7](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.11.6...v0.11.7) (2026-08-02)

### Bug Fixes

* refuse an ambiguous device, and name the project a hub serves ([ab35cbc](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/ab35cbceb758e1386cbe930ef8b44bda938bd27e))

## [0.11.6](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.11.5...v0.11.6) (2026-08-02)

### Bug Fixes

* **dashboard:** the project context panel had no styles at all ([afd3349](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/afd3349db8a51d3c9f28b4a7ded8857063342292))

## [0.11.5](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.11.4...v0.11.5) (2026-08-02)

### Bug Fixes

* **registry:** advertise stdio as well as http, stdio first ([c2eef7b](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/c2eef7b55e5727cd7db9c4731cbaf49877871368))

## [0.11.4](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.11.3...v0.11.4) (2026-08-02)

### Bug Fixes

* expose an input's value, retry query_ui, align state naming, trust boot state ([23fee16](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/23fee16ee71be3df9b70b1691b684897babca8c7))

## [0.11.3](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.11.2...v0.11.3) (2026-08-02)

### Bug Fixes

* **security:** gate the device socket, bound frames and PNG dimensions ([0a700cf](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/0a700cf88f7f4512a1dd8769b1d578aa91bf39ca))

## [0.11.2](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.11.1...v0.11.2) (2026-08-02)

### Bug Fixes

* **symbolicate:** allow Metro on the local network, not just loopback ([491d264](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/491d264bd10d4aebf90d7d467b547c01d1283383))

## [0.11.1](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.11.0...v0.11.1) (2026-08-02)

### Bug Fixes

* **cli:** start the hub on either runtime from the stdio bridge ([2329296](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/23292960d7cda983c6ca853f506f36a7d6fc9f9c))

## [0.11.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.10.1...v0.11.0) (2026-08-02)

### Features

* run the hub on Node as well as Bun, and fix the store adapter types ([bd9894c](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/bd9894cba3ed4d75ea195fc93550211a29633e0e))
* ship the plugin and the skill for Codex, and drop the Bun requirement ([e8787f5](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/e8787f5a0b71e16ba21f628f132c6d04fbdc1cca))

### Bug Fixes

* **ci:** probe the WebSocket over raw TCP instead of the global client ([3f82e24](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/3f82e24bf9a506023d7513ccb6de6ecca00c5f23))

## [0.10.1](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.10.0...v0.10.1) (2026-08-02)

### Bug Fixes

* **session:** make the artifacts directory ignore itself ([9a65a35](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/9a65a3590a70a513ae724e787d94c3a03bd75cb2))

## [0.10.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.9.0...v0.10.0) (2026-08-02)

### Features

* **dashboard:** show the project context and its contradictions ([38ab973](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/38ab9734d51581da73f2465c7893a0e63c16a1d4))

### Bug Fixes

* **automation:** measure on the New Architecture ([ef8b59e](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/ef8b59e4145e8e72017eeaaf652c64e646f30bdb))
* **source:** walk the owner chain when collecting stacks ([8be58cd](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/8be58cd1399dc6a8c06ea6e8983526b00431f7ac))

## [0.9.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.8.0...v0.9.0) (2026-08-02)

### Features

* **cli:** speak MCP over stdio, and list on Smithery ([70bd134](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/70bd134c872514d9411695ca042f858e94a41243))

## [0.8.0](https://github.com/rn-devtools-hub/rn-devtools-hub/compare/v0.7.1...v0.8.0) (2026-08-02)

### Features

* **source:** symbolicate owner stacks into real file and line ([ff63554](https://github.com/rn-devtools-hub/rn-devtools-hub/commit/ff6355486335d26ca44ebadf5d0f6a3a27e42b80))

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
