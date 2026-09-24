<div align="center">
  <img src="docs/assets/brand/chat-bridge-app-icon.png" alt="Chat Bridge" width="112" height="112">
  <h1>Chat Bridge</h1>
  <p>Vos conversations IA sur Mac, dans WeChat et iMessage.</p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <strong>Français</strong> · <a href="README.es.md">Español</a></p>

![macOS](https://img.shields.io/badge/macOS-13.5%2B-17191C?style=flat-square)
[![Release](https://img.shields.io/github/v/release/section9-lab/chat-bridge?include_prereleases&style=flat-square&color=D5C5A8&labelColor=17191C)](https://github.com/section9-lab/chat-bridge/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-17191C?style=flat-square)](LICENSE)

</div>

## Voir la démo

<p align="center"><img src="docs/assets/chat-bridge-intro.gif" alt="L’introduction de Chat Bridge au premier lancement : l’icône rejoint la barre des menus, un iPhone tenu en main confie une tâche à Claude via iMessage et une autre à Codex via WeChat pendant que le Mac affiche chaque étape, puis une suite part du panneau de la barre des menus" width="960"></p>
<p align="center"><a href="docs/assets/chat-bridge-intro.mp4">MP4 HD · lecture avec pause</a> · <a href="docs/assets/chat-bridge-intro-poster.png">Aperçu fixe</a></p>
<p align="center"><sub>L’introduction de 54 secondes affichée au premier lancement, enregistrée depuis les vues SwiftUI natives de l’app (interface en chinois). Tâches et réponses fictives, sans connexion à de vrais comptes.</sub></p>

## Éloignez-vous du Mac. Poursuivez la conversation.

Chat Bridge est une application macOS qui relie WeChat et iMessage aux agents IA de votre Mac. Lancez une tâche depuis votre téléphone, reprenez une conversation existante et recevez le résultat dans le même échange.

- **Reprendre le fil** — Retrouvez vos conversations avec leur projet et leur contexte.
- **Dire ce dont vous avez besoin** — Créez une conversation, choisissez un projet ou changez d’agent en langage naturel.
- **Recevoir les résultats** — Obtenez les réponses et les images, vidéos ou documents produits par la tâche.
- **Un seul logo** — Cliquez dans la barre des menus pour retrouver votre dernière conversation et votre brouillon.

## Essayez ces messages

> Avec Codex, reprends le projet « Liste de voyage » et prépare mon programme du week-end.

> Crée une conversation Claude sans projet et propose trois idées de petit-déjeuner.

> Liste les conversations Claude du projet « Boutique ».

Le routage intelligent interprète la destination souhaitée. En cas de doute, Chat Bridge conserve le message d’origine et affiche des choix textuels. Répondez avec un numéro ou le texte d’une option pour continuer.

Un accusé de réception indique la destination de chaque tâche. Il est actuellement affiché en chinois :

```text
Codex > 旅行清单 > 周末计划
已收到✅
```

## Démarrer en trois étapes

Choisissez un DMG dans [Releases](https://github.com/section9-lab/chat-bridge/releases) : **arm64** pour Apple Silicon ou **x86_64** pour Intel. Ouvrez-le et faites glisser **Chat Bridge** dans **Applications**. Si aucune version n’est encore disponible, compilez l’application depuis les sources ci-dessous.

Les DMG utilisent une signature ad-hoc et ne sont pas notariés par Apple. Si le premier lancement est bloqué, vérifiez la provenance du téléchargement, puis utilisez **Réglages Système → Confidentialité et sécurité → Ouvrir quand même** pour cette application. Une mise à jour peut nécessiter d’autoriser à nouveau l’accès complet au disque.

<details>
<summary>Compiler et lancer depuis les sources</summary>

Nécessite Xcode Command Line Tools, Python 3 et une connexion internet. Exécutez ces commandes à la racine du dépôt :

```sh
bash scripts/build-app.sh
open "dist/Chat Bridge.app"
```

La compilation utilise par défaut un certificat Apple Development. Sans certificat, ajoutez `CHAT_BRIDGE_SIGNING_IDENTITY=-` avant la commande de compilation. Avec cette signature locale, une mise à jour peut nécessiter d’autoriser à nouveau l’accès complet au disque.

</details>

1. **Connectez un agent** — Installez-le sur le Mac, connectez-vous à votre compte et vérifiez son état dans Chat Bridge.
2. **Associez une messagerie** — Dans Réglages → Canaux de messagerie, scannez le QR code WeChat ou terminez l’association iMessage.
3. **Envoyez votre premier message** — Configurez un service de routage et activez la sélection automatique. Décrivez votre demande depuis le téléphone, ou discutez directement dans le panneau de la barre des menus.

Sans routage intelligent, vous pouvez choisir la destination dans l’application ou utiliser les menus textuels et les commandes manuelles.

## Avec vos agents habituels

**Codex · Claude Code · Cursor · Grok · OpenCode · Hermes Agent**

Chat Bridge utilise la connexion et la configuration de modèle locales de chaque agent. Ouvrez une conversation dans un projet, discutez sans projet ou reprenez un échange existant. La disponibilité dépend de l’installation, de l’authentification, du service de modèle et des capacités de l’environnement d’exécution. Claude Chat et Cowork ne sont pas encore pris en charge.

## Avant de commencer

- Nécessite **macOS 13.5 ou ultérieur**, un Mac éveillé et connecté, et Chat Bridge en cours d’exécution. iMessage nécessite aussi une connexion à Messages et l’accès complet au disque. La compatibilité avec les anciennes bases Messages reste à vérifier.
- Sur Mac, saisissez **@nom de fichier** pour rechercher et joindre un fichier depuis les suggestions ; le trombone à gauche ouvre la même recherche (10 par message, 50 MiB chacun au maximum). Les réponses citent le message d’origine. Les entrées WeChat et iMessage restent **textuelles** : les messages vocaux, images et pièces jointes reçus ne sont pas exécutés comme des tâches. Les fichiers de résultat admissibles peuvent être renvoyés au canal d’origine.
- Les messages peuvent déclencher des modifications de fichiers, des commandes et des accès réseau. Les conversations Codex／Claude Code créées ou reprises par Bridge disposent par défaut des autorisations d’exécution complètes. Associez uniquement vos propres comptes de confiance.
- L’état des conversations est conservé sur le Mac. Les messages passent par les services de messagerie et d’agent choisis. Le routage intelligent transmet aussi le message et les informations de destination pertinentes au service configuré.
- Un envoi au résultat incertain n’est pas automatiquement répété ni réexécuté. L’interface de l’application est actuellement principalement en chinois.

## Pour aller plus loin

[Signaler un problème](https://github.com/section9-lab/chat-bridge/issues) · [Licence MIT](LICENSE)
