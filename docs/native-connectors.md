# Native app connections

Native connectors use credentials configured on your instance. Composio and Pipedream
are optional managed catalogs; their keys are not needed for native connections.

## Configure an application

1. Sign in as the deployment owner and open `/integrations/setup` on your instance.
2. Under **Application credentials**, choose **Add application**. Select the app,
   authorization method and **Acts as** identity where offered. Give the connection
   method a name that members can recognize.
3. For OAuth methods that show **Client ID** and **Client secret**, register the exact
   **Callback URL** in the provider's OAuth settings, then enter those credentials.
   The callback uses the instance's `API_URL` origin and
   `/api/connectors/oauth/callback`; configure the public origin before registering it.
4. Select only the **Permissions** or **Application scopes** needed. Match them in
   the provider's application settings, then save with **Enabled** on.
5. Members open **Apps**, select the app and connection method, then authorize an
   account or enter their credential. Configuring an application does not connect
   an account for them.

**Your application** and **Official application** identify the configured method's
ownership. Both use this instance's configuration; choosing a label does not create
a hosted authorization service.

| App | Authorization and identity |
| --- | --- |
| Google Calendar, Gmail, Drive, Docs, Sheets, Slides, Tasks | User OAuth. Each app has its own permission selection and account connection. Start with the displayed defaults; enable write permissions only for actions that need them. |
| GitHub | Personal access token, user OAuth, or GitHub App installation. For an installation, the owner sets **GitHub App ID** and **Installation ID**. The member connects in the Web app with JSON containing `appId`, `installationId` and `privateKeyPem` for that installation; mobile directs this setup to Web. |
| Linear | Personal API key acts as a user. OAuth can act as **User** or **Application**; select the intended identity before connecting. |
| Slack | Bot token, user token, or OAuth acting as **Bot** or **User**. Configure the matching bot or user scopes; one identity's permissions do not authorize the other. |
| Notion | OAuth, internal integration token or personal access token. Match the integration's capabilities and share the required pages with it. |
| CogineX | MCP OAuth using the configured **MCP endpoint**. |
| Knowai | Machine API key using the configured **API origin**, **Tenant ID** and **Allowed knowledge base IDs**. This method is not delegated personal authorization. |

Available actions depend on both the configured permissions and the credential's
verified access to the resource. A scope switch cannot grant provider permissions.
Changing authorization settings requires existing accounts to authorize again;
disabling a method keeps its account records but prevents their use.

For Google Drive, **Choose accessible files** appears on a new OAuth connection
when the owner enables **Create and use app files** (`drive.file`). It creates a
separate connection limited to app-authorized files; it does not expand an existing
connection's access.

Application secrets and account credentials use the existing instance secret store
(encrypted storage by default, or [optional Infisical](infisical-secrets.md)). Saved
secrets are not displayed again. Enter tokens and private keys only in the credential
forms, not in chat or tracked files.

## Optional event delivery

Events feed explicitly enabled **Routines**. Connecting an account or saving an event
configuration does not itself enable a Routine.

- **Gmail:** expand **Gmail push notifications** and enable **Use Google Pub/Sub**.
  First create the topic, authenticated push subscription and push service account in
  Google Cloud, including the provider's required IAM permissions. Enter the project,
  full topic and subscription resource names, and service account email. Use the
  displayed **Push callback audience** as the push endpoint and audience. Topic and
  subscription must belong to the configured project. Public HTTPS is required;
  without Pub/Sub, enabled Gmail Routines use periodic change checks.
- **Slack:** on a bot application configuration, open **Events**. Enter the **Slack
  App ID** and **Signing secret**, select events, then save. Copy the generated
  **Slack Request URL** to Slack, enable the matching bot event subscriptions and
  scopes, and use **Check verification**. Public HTTPS is required. `app_uninstalled`
  and `tokens_revoked` update connection status and do not trigger Routines.

Slack user data and legacy search also require the platform eligibility indicated in
**Advanced Slack data access**; enabling those switches does not establish eligibility.

## Verify before opening access

Offline and emulated tests cover the local implementation. They do not establish
real provider OAuth, event delivery, platform eligibility or distribution approval.
Validate those with your registered applications and test accounts before enabling
the methods for other users. Saving configuration or verifying a callback alone does
not prove that a Routine receives the intended events.
