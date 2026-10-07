# Changelog

## 1.0.0

First public release, built on version 1.0.0 of the Agentova public API.

- **Agentova** node: list, get, activate and pause the automations of a workspace. Usable as a tool by the AI Agent node.
- **Agentova Trigger** node: starts a workflow on `lead.created`, `run.completed` and `automation.status_changed`. Every delivery is checked against its HMAC-SHA256 signature and its age (5 minutes at most); an event already processed by the same trigger node within 72 hours is acknowledged without starting the workflow again.
- Error messages in English, chosen from the error `code` returned by the API.
