---
name: Bug report
about: Something routed wrong, did not route, or crashed
title: ""
labels: bug
---

<!-- Do NOT paste your TYPESAFE_API_KEY. /router-config prints it masked, on purpose. -->

## What happened

<!-- The prompt you sent, and what the router did with it. -->

- prompt:
- expected: <!-- e.g. routed: security/L -> frontier -->
- actual: <!-- paste the notify text, or "no notify at all" -->

## `/router-config` output

<!-- Run it and paste the lines. Includes the classifier, marker path and resolved models. -->

```text

```

## Which classifier

<!-- One of: Jev (key set), heuristic (no key), heuristic after a Jev failure -->

## Anything unusual about the tier table

<!-- If you set TASK_ROUTER_TIERS, paste it. If a tier shows UNRESOLVED, say which. -->

## Environment

- `pi --version`:
- node `--version`:
- install route: <!-- pi install git:… | clone into ~/.pi/agent/extensions/ | other -->
- OS:

## Extra evidence, if you have it

<!--
- `/router` output for the last decision (prompt, kind, complexity, tier, confidence, provenance)
- `/router-check` result and, if relevant, `/router-check --jev` (the latter needs your key)
- whether `/task-router` reports enabled or disabled
-->
