# n8n-nodes-agentova-ai

This is an n8n community node. It lets you use [Agentova](https://agentova.ai) in your n8n workflows: control the automations of your workspace, and start a workflow when a lead is captured, an automation run completes, or an automation changes status.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

**Full documentation: [docs.agentova.ai/n8n](https://docs.agentova.ai/n8n/overview)**

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Trigger](#trigger) · [Example workflows](#example-workflows) · [Errors](#errors) · [Troubleshooting](#troubleshooting) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. On a self-hosted instance, an owner or admin opens **Settings > Community Nodes**, selects **Install** and enters `n8n-nodes-agentova-ai`. The **Agentova** and **Agentova Trigger** nodes then appear in the nodes panel.

n8n Cloud only offers community nodes that n8n has verified. Until this node is verified, use a self-hosted instance.

More: [Install the node](https://docs.agentova.ai/n8n/install)

## Credentials

Both nodes use the **Agentova API** credential:

| Field            | Value                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Access Token** | An Agentova API key (`agk_live_...`). A workspace admin creates it in Agentova under **Settings > API**. The key is shown only once. |
| **Base URL**     | Keep the default, `https://core-api.agentova.ai/v1`, unless Agentova gives you another address.                                      |

One key gives access to one whole workspace: create one credential per workspace. When you save the credential, n8n tests it with `GET /automations?limit=1`. A revoked key stops working immediately, in every workflow that uses it.

More: [Credentials](https://docs.agentova.ai/n8n/credentials)

## Operations

The **Agentova** node works on the **Automation** resource:

| Operation    | What it does                                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **List**     | Returns the automations of the workspace, one item per automation. Filters: status, type, agent ID. **Return All** fetches every page, 100 automations per request; otherwise the node stops at **Limit** (50 by default).                      |
| **Get**      | Returns one automation.                                                                                                                                                                                                                         |
| **Activate** | Switches an automation to `active` and returns it. If Agentova cannot resume it (for example a CRM source whose connection cannot be restored), the automation ends up in `error` and the node fails with "could not be resumed, now in error". |
| **Pause**    | Switches an automation to `paused` and returns it. Pausing an automation that is already paused succeeds and changes nothing.                                                                                                                   |

The **Automation** field accepts a choice **From List** (searchable by name) or an **ID** (`aut_...`), which you can map from a previous node with `{{ $json.id }}`. Automations in `draft` or `error` cannot be controlled through the API: fix them in the Agentova app first.

Each automation contains `id`, `name`, `type`, `provider`, `agent_id`, `agent_name`, `status` and `updated_at`.

The node can also be connected as a **tool** to n8n's **AI Agent** node. An agent with this tool can pause any automation of the workspace: give it a clear system message about what it may do.

More: [Agentova node](https://docs.agentova.ai/n8n/agentova-node)

## Trigger

The **Agentova Trigger** node starts a workflow when one of the selected events happens in the workspace:

| Event                                                       | Fires when                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| **Lead Created** (`lead.created`)                           | A new lead is captured.                                       |
| **Run Completed** (`run.completed`)                         | An automation run finishes: `success`, `partial` or `failed`. |
| **Automation Status Changed** (`automation.status_changed`) | An automation is activated, paused, or goes into error.       |

Each execution receives one item with `id` (the event ID, `evt_...`), `type`, `created_at` and `data` (the lead, the run, or the automation). The trigger fires for the whole workspace: add an **If** or **Filter** node right after it to keep only what you need.

### Requirements

Agentova notifies n8n over the internet. Your n8n instance must be reachable over **HTTPS** at the address set in its `WEBHOOK_URL`. Agentova refuses plain `http://` addresses, local or private network addresses, and URLs that contain a username or a password. For a local test, a tunnel that gives a public HTTPS address works.

A workspace can have at most 20 active webhook subscriptions, all tools included.

### How it works

- **Activation.** Activating the workflow subscribes this node's webhook URL to the selected events in Agentova; deactivating it deletes the subscription. Use **Listen for test event** to try the trigger before activating the workflow.
- **Repair at activation.** If Agentova disabled the subscription after repeated failed deliveries, if n8n's webhook URL changed, or if the selected events changed, the old subscription is deleted and a new one is created. Leftover subscriptions that point at this node's URL (for example after a failed activation) are deleted before a new one is created. A subscription inherited from another node (a workflow duplicated with n8n older than 2.36 copies the original's subscription) is ignored and left to the original workflow, never deleted.
- **Signature check.** Agentova signs every delivery (HMAC-SHA256 of the raw body). The trigger checks the signature and its age (5 minutes at most). A delivery that fails the check gets a `401`, never starts the workflow, and n8n logs a warning with the reason only, never the secret or the signature.
- **Duplicates.** Agentova can deliver the same event again after a network problem. The trigger acknowledges an event that it has already processed (same event ID, same trigger node) without starting the workflow again. It remembers each event for 72 hours (Agentova never schedules a retry more than 36 hours after an event is created), up to 50,000 events per n8n process. This memory lives in the n8n process: it is lost when n8n restarts and is not shared between instances in queue mode. If a duplicate must never run twice, add n8n's **Remove Duplicates** node right after the trigger, with the operation **Remove Items Processed in Previous Executions** and `{{ $json.id }}` as the value to dedupe on.

More: [Agentova Trigger](https://docs.agentova.ai/n8n/trigger)

## Example workflows

**Pause an automation at night, resume it in the morning**

1. **Schedule Trigger**: every day at 7:00 pm.
2. **Agentova**: Automation > **Pause**, with the automation chosen **From List**.

Duplicate the workflow with **Activate** at 8:00 am. To handle several automations at once, use **Agentova > List** with a filter, then **Agentova > Pause** with the Automation field in **ID** mode and `{{ $json.id }}`.

**Get alerted when an automation goes into error**

1. **Agentova Trigger**: Automation Status Changed.
2. **If**: `{{ $json.data.status }}` is equal to `error`.
3. **Slack**, **Gmail** or any other alert node: "`{{ $json.data.name }}` is in error, check it in Agentova."

**Send new leads to a spreadsheet or a CRM**

1. **Agentova Trigger**: Lead Created.
2. **Google Sheets > Append Row** (or your CRM node): map `name`, `email`, `phone`, `source` and `created_at` from `{{ $json.data }}`.

**Let an AI agent manage your automations**

1. **Chat Trigger** (or Slack, Telegram...).
2. **AI Agent**, with the **Agentova** node connected as a tool, and a system message such as "You can list Agentova automations and pause or activate them. Always confirm the name of the automation before changing it."

More: [Example workflows](https://docs.agentova.ai/n8n/recipes)

## Errors

The node chooses its error message from the error `code` returned by the Agentova API, never from the message text, which can change:

| Code                          | Message in n8n                                       | What to do                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_api_key`             | Invalid or revoked Agentova API key                  | Update the credential with a valid key.                                                                                                         |
| `workspace_access_denied`     | This Agentova workspace has no access to the API     | Check the subscription of the workspace in Agentova.                                                                                            |
| `invalid_request`             | Agentova rejected the request as invalid             | Read the error description: it names the rejected parameter (for the trigger, usually the webhook URL).                                         |
| `automation_not_found`        | Automation not found                                 | Choose the automation again **From List**.                                                                                                      |
| `automation_not_controllable` | This automation cannot be controlled through the API | The automation is in `draft` or `error`, or its mailbox is already used by another active agent (`account_in_use`): fix it in the Agentova app. |
| `webhook_not_found`           | Webhook subscription not found                       | Deactivate, then activate the workflow again.                                                                                                   |
| `route_not_found`             | Agentova API route not found                         | Restore the default Base URL of the credential.                                                                                                 |
| `rate_limited`                | Agentova rate limit reached, retry in N s            | The quota is per API key and shared by every workflow that uses it: slow down (Wait node, smaller batches).                                     |
| `internal_error`              | Agentova internal error                              | Retry later; contact Agentova support if it persists.                                                                                           |
| `service_unavailable`         | The Agentova API is temporarily unavailable          | Agentova has switched the API off for a while. Retry later; events that happen meanwhile can be caught up with the list operations.             |

To keep a workflow running when one item fails, set the **On Error** setting of the node to **Continue**.

## Troubleshooting

- **The trigger never fires.** Check that the workflow is active, that n8n is reachable over HTTPS at its `WEBHOOK_URL`, and that the event really happens in Agentova.
- **"Agentova Trigger: rejected a webhook delivery" in the n8n logs.** The `reason` says why: `signature_mismatch` (the delivery was not signed with the secret of this node's subscription), `stale_timestamp` (check the clock of the n8n server), `no_secret` (this node has no subscription secret). Deactivate, then activate the workflow to get a fresh subscription.
- **The trigger stopped after an outage.** After repeated failed deliveries, Agentova disables the subscription and notifies the workspace admins. Deactivate, then activate the workflow: the trigger replaces the disabled subscription.

More: [Troubleshooting](https://docs.agentova.ai/n8n/troubleshooting)

## Compatibility

Tested with n8n 2.39 (self-hosted). Earlier versions have not been tested.

## Resources

- [Agentova documentation for n8n](https://docs.agentova.ai/n8n/overview)
- [Agentova API documentation](https://docs.agentova.ai)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Development

```bash
npm ci
npm run lint
npm test
npm run build
npm run dev   # starts a local n8n instance with this node loaded
```

`annexes/openapi-v1.yaml` is a copy of the Agentova API contract: `npm test` checks the statuses, types, events and error codes of the nodes against it.

## License

[MIT](LICENSE)
