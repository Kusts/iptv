# Runbook — Browser Drift / Security Challenge

> Status: Operational baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked to prohibit anti-bot/security bypass and unsafe UI improvisation.

## Trigger

Unexpected route/DOM, selector failure, changed confirmation pattern, CAPTCHA, 2FA or other security challenge during provider Browser Worker operation.

## Immediate behavior

1. stop the affected mutation unless postcondition already proves success;
2. capture sanitized screenshot/trace/DOM metadata allowed by evidence policy;
3. mark adapter/provider capability degraded;
4. route ambiguous customer-impacting operation to verification/HITL;
5. do not attempt to bypass CAPTCHA/2FA/security controls.

## Recovery

Use safe account/session to inspect the current provider workflow, update semantic locators/procedure, run adapter validation and release a new adapter version before broad re-enable.

## Auto-review result

Reviewed to prioritize safe adaptation over autonomous improvisation in protected external UIs.
