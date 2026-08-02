# rn-devtools-hub: le runtime d'agent pour React Native

Document produit interne. Base de référence: `rn-devtools-hub@0.5.0`, 28 outils
MCP, 6084 lignes de source.

Ce document ne compare pas le produit à des concurrents. Il part d'un seul fait
technique et en déduit tout le reste.

---

## 1. Le fait dont tout découle

Le SDK vit **à l'intérieur du runtime JavaScript de l'application**.

Un outil piloté par accessibilité voit ce que l'OS expose. Un outil piloté par
WebDriver voit une boîte noire. Un inspecteur d'IDE voit l'arbre mais s'interdit
d'agir. Aucun d'eux ne peut lire les props d'un composant, appeler un handler,
intercepter une requête ou écrire dans un store, parce qu'aucun d'eux n'est
dedans.

**Correction, vérifiée le 1er août 2026.** Cette position n'est pas exclusive.
Buoy (`@buoy-gg/*`, propriétaire, 29 $ par siège et par mois) l'occupe déjà :
inspection de `__REACT_DEVTOOLS_GLOBAL_HOOK__`, parcours des fibers, invocation
directe des handlers, serveur MCP de 13 outils. Vérifié en décompilant leurs
paquets npm publiés, leur dépôt GitHub ne contenant aucun code source.

Ce que cela change: la position dans le runtime est une condition nécessaire,
pas un fossé. Le fossé est ce qu'on en fait. Buoy s'arrête à inspecter et
piloter; il n'a ni assertion, ni contrôle du temps, ni simulation réseau, ni
régression visuelle, ni export de session ou de flow, et il lit `_debugSource`
sans jamais exposer de localisation source en MCP. La couche de preuve est donc
le vrai différenciateur, pas l'emplacement du code. Et l'asymétrie qui reste
structurelle est ailleurs: la couche hôte (simctl, adb, build, permissions,
push) qu'ils n'ont pas, et la licence.

Le critère de sélection de chaque chantier de ce document est donc unique:

> Est-ce que ma position dans le runtime rend cette fonctionnalité **d'une autre
> nature** que ce qu'elle serait vue de l'extérieur, ou seulement plus commode ?

Une bonne idée venue d'ailleurs est la bienvenue. Elle n'entre dans ce document
que retournée: reprise depuis l'intérieur du runtime, elle doit produire quelque
chose que sa version d'origine ne peut pas produire.

Ce qui ne passe pas ce filtre n'est pas interdit, mais ne porte aucun avantage:
c'est de la plomberie, à faire vite et sans y investir de récit.

## 2. Positionnement

> Votre agent voit l'app comme React la voit, sait quel fichier a produit chaque
> élément, agit sans coordonnées, et prouve que ça marche.

La cible n'est pas le développeur qui debug à la main. C'est l'équipe qui laisse
un agent travailler sur son app mobile.

La deuxième proposition de cette promesse (« sait quel fichier ») ne doit être
publiée qu'une fois le chantier 4 livré et vérifié sur une app réelle. Tant
qu'elle n'est pas tenue, le README s'en tient aux trois autres.

## 3. État des lieux

Ce qui existe et qui porte déjà la position:

- parcours de fibers via `__REACT_DEVTOOLS_GLOBAL_HOOK__`, arbre sémantique des
  composants visibles, filtrage des écrans montés mais cachés par le navigateur
  (`src/client/automation.ts`)
- action par props (`onPress`, `onChangeText`, `scrollTo`) sans coordonnées ni
  bridge natif
- bus d'événements corrélé et curseur monotone par device, avec attente
  bloquante (`get_events_since`, `wait_for_event`)
- adaptateur natif côté hôte pour ce que le runtime ne peut pas atteindre
  (permissions, lancement, captures, logs natifs)

Ce qui manque et que la position permettrait:

- aucune localisation source n'est exposée. Vérification faite: `_debugSource`,
  `_debugOwner`, `__source`, `getInspectorDataForViewAtPoint` sont absents de
  `src/`. L'agent sait qu'un bouton existe, pas quel fichier l'a produit.
- aucune primitive de preuve. Vérifier un résultat impose une capture, lente,
  chère en tokens et incapable de voir ce qui n'a pas de pixel.
- aucun accès aux stores. Le panneau React Query du dashboard est alimenté par
  une commande `query.cache` que l'app enregistre elle-même: il n'y a aucun
  adaptateur dans `src/client`.
- aucune persistance. L'historique est en mémoire, plafonné à 3000 événements
  par device, et les `screen.frame` ne sont jamais historisés.

---

## 4. Les chantiers

Chacun est présenté sous la forme: l'idée d'origine, puis ce que la position
dans le runtime en fait.

### 4.1 Localisation source sur l'arbre ET sur le bus

L'idée d'origine relie un pixel à une ligne de code, pour un humain, un élément
à la fois.

Version runtime: la localisation est posée sur l'arbre entier en un appel, avec
la chaîne des composants propriétaires, **puis sur les événements**. Un
`network.request` qui porte `src/hooks/useOrders.ts:31`. Un `crash` qui porte le
composant qui l'a déclenché. Un `ui.change` qui dit quel fichier a provoqué le
re-render.

Un inspecteur d'IDE ne peut pas faire ça: il inspecte une vue, il n'observe pas
un flux corrélé. C'est le chantier le plus rentable du document.

Voies à évaluer, par ordre de robustesse présumée:

1. `_debugOwner` et les owner stacks (`_debugStack`), disponibles en dev
2. `getInspectorDataForInstance` de React Native, qui prend un fiber
3. la prop `__source`, uniquement avec le runtime JSX classique

Attention: avec le runtime JSX automatique (défaut depuis RN 0.71 et Expo), la
source part en argument de `jsxDEV` et n'atterrit donc pas dans `memoizedProps`.
React 19 a par ailleurs retiré `_debugSource` du fiber. La voie `__source` est
donc un repli, pas la voie principale. C'est le seul risque technique du plan:
implémentation en cascade, chaque voie testée, dégradation en `source: null`.

### 4.2 Contexte projet: déclaré, réel, divergent

L'idée d'origine lit des fichiers et retourne les versions déclarées.

Version runtime: le hub lit le disque, le SDK lit le runtime, et l'outil retourne
les deux plus **ce qui ne colle pas**.

```
declared    hub, lecture disque       package.json, lockfile, app.json,
                                      Expo SDK, plugins, scheme
runtime     SDK, lecture des globals  moteur JS, New Architecture, bridgeless,
                                      TurboModules, version du renderer React
divergence  hub, comparaison          ce qui contredit
```

Le bloc `runtime` se lit entièrement dans les globals, sans un seul import, donc
sans toucher à l'invariant zéro dépendance de `src/client`:

| Champ | Source |
|---|---|
| moteur JS et version | `global.HermesInternal.getRuntimeProperties?.()` |
| New Architecture active | présence de `global.nativeFabricUIManager` |
| bridgeless | `global.RN$Bridgeless` |
| TurboModules | `global.__turboModuleProxy` |
| mode dev | `__DEV__` |
| version du renderer React | `__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers` |

Le troisième bloc est le produit. « Le projet déclare la New Architecture, le
runtime ne l'a pas: ton build natif est périmé, reconstruis avant de chercher
plus loin. » Aucun outil qui lit des fichiers ne peut écrire cette ligne, aucun
outil hors runtime non plus. Il faut être aux deux endroits.

### 4.3 Preuve: un outil `assert` unique

Aujourd'hui, vérifier un résultat veut dire prendre une capture et la regarder.

Version runtime: des assertions qui prouvent **ce que les pixels ne montrent
pas**. Une capture ne dira jamais qu'une requête a échoué en silence, qu'une
erreur console est apparue, qu'un composant s'est démonté pendant une mise à
jour d'état.

Un seul outil, `assert({ kind, ... })`, pour ne pas gonfler la liste d'outils:

| kind | Prouve |
|---|---|
| `network_ok` | aucune requête en erreur sur la fenêtre |
| `no_console_error` | aucun `console.error` sur la fenêtre |
| `no_crash` | aucun crash ni rejet non capturé |
| `visible` | un élément est présent et visible |
| `absent` | un élément a disparu |
| `text` | un texte est présent |

Fenêtre de retry intégrée: une assertion attend, elle n'échoue pas sur le
premier essai. En cas d'échec, elle retourne la preuve attachée (événements
fautifs, arbre au moment de l'échec).

C'est le prérequis du chantier 4.6.

### 4.4 Persistance et export de session

L'idée d'origine attache des captures à un rapport de bug.

Version runtime: la session complète, horodatée sur une même ligne de temps,
lisible par un agent. Événements, réseau, logs, crashes, arbres UI successifs,
captures, erreurs de build.

Prérequis non négociable: l'historique doit cesser d'être en mémoire et
plafonné. Persistance sur disque en JSONL, par device et par session, avec une
rétention configurable.

Usage: un agent enquête sur un bug après coup sans rejouer le scénario, et la
sortie s'attache telle quelle à une issue.

### 4.5 Enregistrement vidéo aligné sur le bus

L'idée d'origine enregistre l'écran.

Version runtime: la vidéo est horodatée **sur la même ligne de temps que les
événements**. L'artefact n'est pas une vidéo, c'est une vidéo dont l'image à
4,2 s correspond au crash numéro 187 et à la requête `/orders` qui a échoué.
Personne d'autre ne peut aligner des pixels sur des événements internes à
l'app.

### 4.6 Export de flow action / conséquence

L'idée d'origine enregistre des gestes vus de l'extérieur: un tap à des
coordonnées ou sur un testID. Elle ne peut rien affirmer sur ce qui s'est passé
dans l'app.

Version runtime: une suite **action / conséquence**. L'action sémantique (role
plus nom accessible), l'événement qui en a résulté, et la localisation source.

```
tap    role=button name="Commander"
wait   network.response POST /orders 201
assert visible text="Commande confirmée"
```

Un flow enregistré de l'extérieur ne peut pas assurer la deuxième ligne. C'est
un test qui vérifie une causalité, pas un replay de gestes.

Dépend de 4.3.

### 4.7 Previews in situ

L'idée d'origine monte un composant dans une coquille vide. Son coût réel est de
remocker les providers, la session, le cache.

Version runtime: le composant est monté **dans l'app vivante**, sous ses vrais
providers, avec la vraie session et le vrai cache. Zéro mock. Retour: arbre,
rect mesuré, capture. Puis démontage.

Contrainte: Metro résout statiquement, donc un chemin de fichier arbitraire ne
peut pas être requis à l'exécution. La signature est
`devtools.registerPreview(name, factory)` côté app, puis
`render_component({ name, props })` côté MCP.

### 4.8 Déterminisme au niveau JS

L'idée d'origine ne peut pas exister hors du runtime.

Version runtime: `freeze_time`, `advance_time`, `mock_network`,
`set_network_condition`. Le SDK intercepte `Date`, les timers et l'implémentation
de `fetch` qu'il instrumente déjà.

Promesse à tenir, précise: **déterminisme au niveau JS**, sur le temps, le réseau
et les données. Pas sur les animations natives ni sur Reanimated côté thread UI,
qui utilisent des horloges natives. La version vague (« reproductible ») serait
démentie à la première démo avec une transition; la version précise reste hors
d'atteinte de tout outil extérieur.

### 4.9 Diff visuel expliqué

L'idée d'origine compare deux images et retourne un score.

Version runtime: un diff **expliqué**. Le diff localise la région, l'arbre
source-mappé nomme le composant qui la possède, le bus dit ce qui a changé
depuis la baseline.

> Les 4 % de différence sont dans la région rendue par `ServiceCard.tsx:42`, et
> le seul `ui.change` depuis la baseline suit une réponse `/services` au payload
> différent.

C'est un diagnostic, pas une image. Dépend de 4.1.

Le décodage PNG se fait avec `node:zlib` et un parseur de chunks maison, pour
préserver le zéro dépendance.

### 4.10 Lecture et écriture des stores

L'idée d'origine affiche l'état.

Version runtime: l'**écriture**. Mettre l'app dans un état exact sans traverser
dix écrans n'est faisable que depuis l'intérieur. Et ça compose avec 4.6: un
flow exporté démarre par une injection d'état plutôt que par une séquence de
login, ce qui rend les tests rapides et hermétiques.

`registerStore(name, { get, set })` côté app, `get_state` et `set_state` côté
MCP. Adaptateurs fournis pour React Query, Zustand et Redux, sans import: le
SDK reçoit l'instance, il ne l'importe pas.

### 4.11 Perception hybride et audit d'accessibilité

L'idée d'origine fait de l'accessibilité la seule source de vérité.

Version défensive, attendue: un repli quand le runtime React n'est pas joignable
(build release, WebView, écran natif, splash), avec un champ
`source: "react" | "accessibility"` sur chaque nœud.

Version offensive, spécifique: quand les deux sources sont disponibles, les
**comparer**. Ce qui est rendu par React mais absent de l'arbre d'accessibilité,
c'est ce que les technologies d'assistance ne voient pas. Un outil purement
accessibilité ne peut pas savoir ce qui manque, il ne voit que ce qui existe. Un
outil purement React ne sait pas ce que l'OS expose. Avoir les deux donne un
audit réel.

Android via `uiautomator dump`. iOS conditionné à AXe, déjà optionnel dans
`tap_native`.

### 4.12 Erreurs de build dans le bus

L'idée d'origine construit l'app.

Version runtime: déléguer la construction (`expo run:ios`, `expo run:android`,
`eas build`) n'apporte rien en soi. Ce qui apporte, c'est de faire entrer les
erreurs de build **dans le même bus horodaté** que les crashes et le réseau.
Erreur de compilation à t0, relance à t1, premier crash JS à t2, une seule ligne
de temps. L'agent lit un flux continu du code cassé jusqu'à l'app qui tourne.

### 4.13 Plomberie native

Sans avantage de position, à faire vite: `install_app`, `uninstall_app`,
`set_orientation`, `get_orientation`. Ça bouche des trous, c'est peu cher, ça ne
raconte rien.

### 4.14 Mode CI

Un mode `--ci` produisant du JUnit XML, un code de sortie exploitable, et des
artefacts. La spécificité: l'artefact contient la vérité interne (réseau, logs,
état, arbres successifs), pas seulement des captures et un code de sortie. Un
échec de CI devient débuggable sans reproduire.

---

## 5. Obstacles de faisabilité

Ceux-ci sont des faits de code, indépendants de toute considération de marché.

1. **`MCP_COMMAND_TIMEOUT_MS = 8000`** (`server/server.mjs`), plafond dur sur
   toute commande vers le device. Previews, snapshots, assertions avec retry,
   `get_state`: tout passe par `sendDeviceCommand`. À corriger en premier.
2. **Metro résout statiquement.** Un chemin de fichier arbitraire ne peut pas
   être requis à l'exécution. D'où le registre de previews.
3. **Le runtime JSX automatique ne met pas la source dans les props.** Voir 4.1.
   Prototype avant tout engagement de communication.
4. **L'historique est en mémoire et plafonné à 3000 événements.** Les
   `screen.frame` ne sont jamais historisés. `export_session` a besoin d'une
   persistance qui n'existe pas.
5. **Le diff visuel demande un décodeur PNG.** Résolu par `node:zlib`, pas par
   une dépendance.
6. **`get_state` n'est pas une généralisation.** Le panneau React Query est
   alimenté par l'app. Il n'y a aucun adaptateur dans `src/client`. C'est du
   neuf.
7. **Retirer bun est un portage**, pas une ligne de documentation: `Bun.serve`,
   `Bun.spawn`, `Bun.which`, et Node 20 n'a pas de serveur WebSocket natif. Hors
   périmètre de ce document, à traiter séparément.

## 6. Ce qu'il ne faut pas faire

1. **Ne pas chercher la parité de panneaux avec React Native DevTools.** Intégré
   depuis RN 0.76, gratuit, zéro installation.
2. **Ne pas reconstruire un index documentaire.** Coût de maintenance permanent,
   Context7 couvre le besoin.
3. **Ne pas réimplémenter xcodebuild ni gradle.** Déléguer, et n'apporter que le
   flux d'erreurs corrélé. Voir 4.12.
4. **Ne pas viser le device physique iOS** avant que tout le reste soit solide.
   `go-ios` et WebDriverAgent sont un puits de maintenance.
5. **Ne pas ajouter de dépendance native au SDK.** C'est ce qui a tué Flipper, et
   c'est l'argument central du produit.
6. **Ne pas laisser la liste d'outils enfler.** 28 outils que personne n'enchaîne
   est déjà un problème d'utilisabilité. Chaque chantier regroupe (`assert`
   unique, `get_project_context` unique) plutôt que d'ajouter une entrée par
   variante. Une skill qui apprend à enchaîner fait partie du produit.

## 7. Séquencement par dépendances

Le bon ordre n'est pas celui de l'effort, c'est celui des dépendances: quatre
chantiers en alimentent d'autres.

```
0.  déplafonner le timeout de 8 s              débloque tout
1.  get_project_context                        peu cher, effet immédiat
2.  assert() unique                            prérequis de 6
3.  source sur l'arbre, puis sur le bus        le différenciateur, prérequis de 8
4.  persistance de session                     prérequis de 5
5.  export_session                             a besoin de 4
6.  enregistrement et export de flow           a besoin de 2
7.  previews in situ                           a besoin d'un registre app
8.  diff visuel expliqué                       a besoin de 3
9.  déterminisme JS                            autonome
10. get_state et set_state                     rend 6 hermétique
11. perception hybride et audit a11y           autonome
12. erreurs de build dans le bus               a besoin de 4
13. plomberie native et mode CI                autonome
```

## 8. Résumé

La chaîne que la position dans le runtime rend possible, et qu'aucune autre
position ne permet d'assembler:

> l'agent perçoit l'app par le runtime React, obtient le fichier et la ligne qui
> ont produit chaque élément et chaque événement, agit sans coordonnées, contrôle
> le temps et le réseau pour être déterministe au niveau JS, prouve le résultat
> par assertion et par diff expliqué, puis exporte le tout en test rejouable et
> en session corrélée.

Chaque maillon isolé est imitable, et la position dans le runtime l'est aussi:
quelqu'un l'occupe déjà (voir la correction en section 1). Ce qui ne l'est pas à
bon compte, c'est la chaîne entière, et le fait qu'elle soit MIT et gratuite en
face d'une offre fermée à 29 $ par siège.
