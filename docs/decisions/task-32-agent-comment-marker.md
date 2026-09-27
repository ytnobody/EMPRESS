# Task #32 — Robust agent-vs-human comment detection (gh mode)

## Context
In gh mode every issue comment is authored by the CLI token account, so
`hasHumanReply` (taskstore/shared.ts) distinguishes agent from human **only** by
the `**[agent]**` body-prefix convention. That heuristic is fragile:
- a human echoing `**[empress]** …` (any `**[…]**`) is misread as the agent, and
- an agent comment lacking the prefix is misread as a human reply.

The prefix must stay (humans read it) but detection must no longer depend on it.

## Behavior spec
1. **Every harness-posted comment** (both backends) embeds an unambiguous,
   machine-checkable, unique-per-post marker as an invisible HTML comment:
   `<!--empress:agent=<uuid>-->` — appended on its own line.
2. `hasHumanReply(t)`: the **latest** comment is an *agent* comment iff its body
   contains the marker `<!--empress:agent=`; otherwise it is a *human* reply.
   The `**[agent]**` prefix is **not a signal**.
3. Human readability is unchanged: gh-comment bodies keep `**[agent]** <body>`;
   local comments keep the truthful `author` field (taskBrief already renders
   `- [author] body`), so no prefix is added there.
4. Clarify-flow prompts (cli/run.ts CLARIFY_MSG, agents/superintendent.md) state
   the machine rule instead of the prefix rule.

## Interface shapes (what tests verify)
| Symbol | Shape |
|---|---|
| `agentMarker(): string` | `<!--empress:agent=<uuid v4>-->` (unique per call) |
| `hasHumanReply(t)` | agent iff last comment body contains `/<!--empress:agent=/` |
| gh `addComment` Command | `gh api repos/<repo>/issues/<id>/comments --method POST -f body=**[<author>]** <body>\n<marker>` |
| local `addComment` | stored comment `{at, author, body: <body>\n<marker>}` |

## Verification table (hasHumanReply)
| last comment body | result |
|---|---|
| `[]` (no comments) | `false` |
| `**[empress]** …` / `**[superintendent]** …` — prefix, no marker (human mimicking) | `true` |
| plain text — no marker | `true` |
| `<body>\n<!--empress:agent=<uuid>-->` (with or without prefix) | `false` |

## Assumptions (handoff)
- `[ASSUMPTION]` Pre-existing agent comments posted before this change carry no
  marker and will read as human replies. Impact: only in-flight threads whose
  *latest* comment predates deploy; the next post-deploy comment re-establishes
  the marker. Accepted — no rollover migration.
- `[ASSUMPTION]` Detection is marker-presence, not registry verification of the
  nonce. A deliberate copy of the full marker is out of threat model (stated
  problem is *accidental* prefix mimicry).

## Non-goals
- No tracking/registry of agent comment ids.
- No change to the `[github]` push/PR flow.