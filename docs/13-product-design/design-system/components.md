# Component Inventory

> Status: Canonical baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — risk/unknown states included.

## Foundations

Button, IconButton, Link, Input, Textarea, Select, Combobox, Checkbox, Radio, Switch, Tooltip, Popover, Dialog, Drawer, Tabs, Badge, Avatar, Separator.

## Operational components

- StatusBadge
- RiskBadge
- HealthScore
- MoneyValue
- MetricDelta
- EntityLink
- EvidenceLink
- AuditStamp
- Timeline
- ActivityItem
- AttentionItem
- FilterBar
- DataTable
- EmptyState
- ErrorState
- DependencyStatus
- ProviderOperationStatus
- HumanReviewCard
- ToolExecutionRow
- KnowledgeConfidence
- TrialEligibilityResult
- EntitlementList
- RecurringCostBreakdown

## Action components

- ActionMenu with permission filtering
- ConfirmActionDialog
- HighRiskApprovalDialog
- UnknownEffectBanner
- RetryAfterVerificationAction

## AI components

- AgentMessage
- HumanMessage
- ToolStatus
- HumanTakeoverBanner
- PolicyBlockedNotice
- AgentReleaseBadge
- Source/EvidenceDrawer

## Rules

Components render canonical state; they do not reinterpret state names locally.
