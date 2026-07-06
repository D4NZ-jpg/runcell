# Structured output

Runs come in two shapes. **With a schema**, the agent must submit a payload
matching it, and `result.data` is validated, typed output your code can rely
on. **Without one**, the run is a plain turn and the model's text is the
output.

## With a schema

```ts
import { createAgent } from 'runcell';
import { z } from 'zod';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });

const result = await agent.run({
  prompt: 'Triage this bug report.',
  files: [{ path: 'report.txt', text: report }],
  schema: z.object({
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    rationale: z.string(),
    recommendedFixes: z.array(z.string()),
  }),
});

result.data.severity; // typed: 'low' | 'medium' | 'high' | 'critical'
```

How it works: the schema is exposed to the agent as a required submission
contract. The agent works in its sandbox (reading files, running commands,
calling your tools), and must finish by submitting a payload. runcell validates
that payload against your schema before returning — `result.data` is
authoritative; `result.text` is the surrounding prose, useful for logs.

## Repair turns

If the agent finishes without submitting a valid payload, runcell runs a
repair turn asking it to correct the submission. Configure the budget with
`maxRepairs` (default `1`):

```ts
const agent = createAgent({ model, maxRepairs: 2 });
```

If the budget is exhausted, `run` rejects with `IncompleteResultError` — you
never receive unvalidated data.

```ts
import { IncompleteResultError } from 'runcell';

try {
  await agent.run({ prompt, schema });
} catch (error) {
  if (error instanceof IncompleteResultError) {
    // agent never produced a valid structured result
  }
}
```

Repair attempts are observable via the `onRepair` event
(see [Files, tools, and events](./files-tools-events.md)).

## Schema libraries: Standard Schema

`schema` accepts anything implementing
[Standard Schema](https://standardschema.dev) — Zod 3.24+, Zod 4, Valibot,
ArkType, and others. No lock-in to a specific library or version:

```ts
import * as v from 'valibot';

await agent.run({
  prompt,
  schema: v.object({ ok: v.boolean() }),
});
```

One nuance: libraries that can produce JSON Schema (Zod does out of the box)
give the model the most precise description of the expected payload. Bare
Standard Schema validators still work — they validate the final output, with
generic guidance to the model.

## Without a schema: plain turns

Omit `schema` and the turn's streamed text **is** the output:

```ts
const reply = await agent.run({ prompt: 'Summarize our options.' });

reply.text; // the model's reply — authoritative
reply.data; // undefined (typed as undefined)
reply.finishReason; // why the turn ended, e.g. "stop"
```

No submission contract, no repair loop, one turn. This is the mode chat
replies want — see [Building a chat agent](./chat-agent.md).

## Choosing per run

`schema` is a per-run decision, so one agent freely mixes both shapes — plain
conversational turns and structured extraction turns — even within the same
[thread](./threads.md).
