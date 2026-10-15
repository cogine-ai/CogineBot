# Data processing and privacy

This document describes data handling in CogineBot's open-source clients and self-hosted server. The person or organization operating your server chooses its hosting, enabled services, access controls, backups, and retention practices. If someone else operates your server, ask them for their privacy policy and contact information.

## Data stored by your deployment

The server uses PostgreSQL for account and authentication records, including names, email addresses, password hashes, sessions, and available session IP addresses and user agents. It also stores Bot and group settings, messages, tasks and runs, memories, skills, connection metadata, usage records, and mobile AI data-sharing choices.

Uploaded and generated files are stored under the deployment's `DATA_DIR`, alongside Bot working directories and other application state. Bot computers can retain browser profiles and website login sessions. Registered mobile push tokens are also stored by the deployment. The standard Docker installation persists the database and application files in Docker volumes.

Application-managed connection secrets use an AES-256-GCM secret store by default, with a key supplied by the operator. Operators can configure an external Infisical secret store instead. This does not encrypt every database field, attachment, browser profile, or log. Chats and files are not end-to-end encrypted against the server operator.

## Data on your device

The desktop app saves its selected server address and setup mode in its local application profile. Electron keeps browser cookies, site storage, and caches used for login and interface preferences for the servers you connect to. Creating a local server also saves its Compose configuration and generated deployment secrets under that profile; its database and application data remain in Docker volumes. Connecting to another server sends application requests to that server.

## Configured external services

Depending on the features and connections enabled for your deployment, account, and Space:

- Models and agent services receive task input and relevant context, which can include messages, history, Bot instructions, memories, attachments, screenshots, and connected-app content. A configured gateway can forward requests to other model providers. Local model servers are also supported.
- App connectors and MCP servers receive tool names, arguments, account or routing identifiers, and content needed for requested actions. They can read or change data in connected accounts according to the connection and tool permissions. Hosted computers and cloud agents receive the commands, files, or task context needed to run them.
- Voice services receive recordings for transcription or text for speech generation. Configured memory services receive memory content, search queries, and partition identifiers.
- When mobile push is registered, Expo receives the push token, notification title and body, and navigation identifiers such as the Space, Bot, or thread. Configured email, messaging, login, or billing services process the information needed for their respective features.

Those services have their own processing and retention practices. Disconnecting a service or deleting local records does not recall data already sent to it.

The mobile app asks about configured AI recipients before relevant new foreground actions. Declining blocks that mobile action. Permission is recorded for the user, Space, recipient, and disclosure version. Revoking it affects new mobile actions; existing runs and routines continue until separately stopped. Web, desktop, and server workflows use configured connections without this mobile permission prompt.

## Updates and diagnostics

Installed desktop builds check CogineBot's GitHub releases shortly after launch and hourly afterward, and download available stable updates. Requests to GitHub and its download infrastructure expose normal network/request information and include a randomly generated installation identifier used by the update library, saved locally as `.updaterId`. Set `RAKAZO_DISABLE_AUTO_UPDATE=1` for the desktop process to disable its updater. Server installation and update operations also contact the configured source repository and image registries.

Service logs go to standard output and standard error by default. The operator can change the log level or forward logs; Axiom forwarding requires its token and dataset configuration. Logging includes redaction, but operators should still treat diagnostics as potentially sensitive. Optional Pi session recording (`PI_SESSION_RECORDING=true`) saves unencrypted transcripts under `DATA_DIR`; it is off by default.

## Retention and operator policies

There is no single retention period covering every deployment, backup, log, or external provider. Existing account and Bot deletion features remove data within their scope; shared records, retained usage attribution, backups, device profiles, and copies held by external services can have separate lifecycles. Ask the server operator about access, export, deletion, retention, and enabled services.

Operators serving other people should publish a policy describing their actual deployment and a way to contact them. Set the server's `PRIVACY_POLICY_URL` to that policy to replace this document in the mobile AI data-sharing links. This repository document describes the software; it does not establish every operator's practices or provider agreements.
