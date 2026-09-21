<div align="center">
  <img src="docs/assets/brand/chat-bridge-app-icon.png" alt="Chat Bridge" width="112" height="112">
  <h1>Chat Bridge</h1>
  <p>Tus conversaciones de IA del Mac, en WeChat e iMessage.</p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <strong>Español</strong></p>

![macOS](https://img.shields.io/badge/macOS-14%2B-17191C?style=flat-square)
[![Release](https://img.shields.io/github/v/release/section9-lab/chat-bridge?include_prereleases&style=flat-square&color=D5C5A8&labelColor=17191C)](https://github.com/section9-lab/chat-bridge/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-17191C?style=flat-square)](LICENSE)

</div>

## Mira cómo funciona

<p align="center"><img src="docs/assets/chat-bridge-demo.gif" alt="Recorre Chat Bridge en un MacBook y envía desde la barra de menús; después usa WeChat e iMessage en un iPhone sostenido en la mano para encargar tareas a Codex y Claude y recibir los resultados" width="1100"></p>
<p align="center"><a href="docs/assets/chat-bridge-demo.mp4">MP4 HD · puedes pausarlo</a> · <a href="docs/assets/chat-bridge-demo-poster.png">Vista estática</a></p>
<p align="center"><sub>Demostración de 75 segundos con vistas nativas de Mac y escenas de dispositivos compuestas. Las tareas y respuestas son ficticias; no se conecta a cuentas reales.</sub></p>

## Aléjate del Mac sin perder el hilo

Chat Bridge es una aplicación para la barra de menús de macOS que conecta WeChat e iMessage con los agentes de IA de tu Mac. Inicia una tarea desde el teléfono, retoma una conversación y recibe el resultado en el mismo chat.

- **Continúa donde lo dejaste** — Conserva el proyecto y el contexto de tus conversaciones.
- **Di lo que necesitas** — Crea una conversación, elige un proyecto o cambia de agente con lenguaje natural.
- **Recibe el resultado** — Obtén respuestas y los archivos generados, incluidas imágenes, vídeos y documentos.
- **Un solo logo** — Haz clic en la barra de menús para volver a la última conversación y a tu borrador.

## Prueba con estos mensajes

> Usa Codex para continuar el proyecto «Lista de viaje» y organizar mi fin de semana.

> Crea una conversación de Claude sin proyecto y dame tres ideas para desayunar.

> Muéstrame las conversaciones de Claude del proyecto «Tienda».

Con el enrutamiento inteligente activado, Chat Bridge identifica el destino de tu mensaje. Si no puede decidir, conserva el texto original y ofrece opciones. Responde con un número o con el texto de una opción para continuar.

La confirmación muestra el destino de cada tarea. Actualmente se presenta en chino:

```text
Codex > 旅行清单 > 周末计划
已收到✅
```

## Empieza en tres pasos

Elige un DMG en [Releases](https://github.com/section9-lab/chat-bridge/releases): **arm64** para Apple Silicon o **x86_64** para Intel. Ábrelo y arrastra **Chat Bridge** a **Applications**. Si todavía no hay una versión disponible, puedes compilarla desde el código fuente siguiendo las instrucciones de abajo.

Los DMG usan firma ad-hoc y no están notarizados por Apple. Si se bloquea el primer inicio, comprueba el origen de la descarga y usa **Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente** para esta aplicación. Tras una actualización, puede ser necesario volver a conceder acceso total al disco.

<details>
<summary>Compilar y ejecutar desde el código fuente</summary>

Necesitas Xcode Command Line Tools, Python 3 y conexión a internet. Ejecuta lo siguiente desde la raíz del repositorio:

```sh
bash scripts/build-app.sh
open "dist/Chat Bridge.app"
```

La compilación usa un certificado Apple Development de forma predeterminada. Si no tienes uno, antepón `CHAT_BRIDGE_SIGNING_IDENTITY=-` al comando de compilación. Con esta firma local, una actualización puede requerir que vuelvas a conceder acceso total al disco.

</details>

1. **Conecta un agente** — Instálalo e inicia sesión en el Mac. Después comprueba su estado en Chat Bridge.
2. **Vincula un canal de mensajes** — Abre Ajustes → Canales de mensajes. Escanea el QR de WeChat o completa la vinculación de iMessage.
3. **Envía el primer mensaje** — Configura un servicio de enrutamiento y activa la selección automática. Explica lo que necesitas desde el teléfono o conversa en el panel de la barra de menús.

Sin enrutamiento inteligente, puedes seleccionar el destino en la aplicación o usar menús de texto y comandos manuales.

## Con tus agentes habituales

**Codex · Claude Code · Cursor · Grok · OpenCode · Hermes Agent**

Utiliza el inicio de sesión y la configuración del modelo de cada agente en tu Mac. Crea conversaciones dentro de un proyecto, conversa sin proyecto o retoma una conversación existente. La disponibilidad depende de la instalación, la autenticación, el servicio del modelo y las capacidades del entorno de ejecución. Claude Chat y Cowork aún no son compatibles.

## Antes de empezar

- Requiere **macOS 14 o posterior**, con el Mac despierto, conectado a internet y Chat Bridge en ejecución. iMessage también necesita una sesión en Mensajes y acceso total al disco. La compatibilidad con bases de datos antiguas de Mensajes aún debe verificarse.
- En Mac, escribe **@nombre de archivo** para buscar y adjuntar archivos desde las sugerencias; el clip de la izquierda abre la misma búsqueda (hasta 10 por mensaje y 50 MiB por archivo). Las respuestas citan el mensaje original. WeChat e iMessage siguen admitiendo solo **texto como entrada**; los audios, imágenes y archivos recibidos no se ejecutan como tareas. Los archivos de resultados compatibles pueden devolverse al chat de origen.
- Los mensajes pueden provocar cambios en archivos, ejecutar comandos y acceder a la red. Las conversaciones de Codex／Claude Code creadas o retomadas por Bridge usan permisos completos de ejecución de forma predeterminada. Vincula únicamente tus propias cuentas de confianza.
- El estado de las conversaciones se guarda en el Mac. Los mensajes pasan por los servicios de mensajería y del agente que elijas. El enrutamiento inteligente también envía el mensaje y los datos pertinentes del destino al proveedor configurado.
- Si el resultado de un envío es incierto, no se reenvía ni se ejecuta de nuevo automáticamente. La interfaz de la aplicación está actualmente, en su mayor parte, en chino.

## Más información

[Informar de un problema](https://github.com/section9-lab/chat-bridge/issues) · [Licencia MIT](LICENSE)
