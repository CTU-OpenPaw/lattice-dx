# UC1 backend handoff — 19 October 2026

The approved scope is Duy's backend integration readiness: restore the existing local
stack, verify procurement/outbox behavior, and give Nhi an exact producer contract.
Do not implement Nhi's n8n receiver or broker mapper, or Hung's UI in this change.

Use the existing REST/PostgreSQL acceptance instead of adding another business API.
Extend it to compare the persisted handover event with the authenticated workflow
snapshot and audit, then export a local fixture under ignored `output/`. The exported
artifact contains local demo business data, never credentials. Its format version is
separate from workflow revision. The test continues to use an isolated queue and a
controlled receiver; it must never claim public backlog or imply broker delivery.

The integration handoff specifies ID namespaces, authentication, acknowledgement and
retry semantics. New demo handovers use the existing proposed canonical Asset URN;
the general workflow API continues to accept its documented text asset reference.
Unknown/legacy references require explicit mapping, not silent normalization.

Verify the running core and broker separately. Record missing delivery/token-refresh/
rule/model work honestly. Keep Notion checkboxes unchanged. No runtime worker is
enabled globally and no release is created.
