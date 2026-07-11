# Structured output

A run may include a schema or omit one. With a schema, the agent must submit a
matching value, and `result.data` contains validated, typed output. Without a
schema, the model's text is the output.

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

The schema becomes a required submission contract. After working in its
sandbox, the agent must submit a value, which runcell validates against the
schema before returning. `result.data` contains the validated value, while
`result.text` contains surrounding prose for logging.

## Repair turns

If the agent finishes without submitting a valid payload, runcell runs a
repair turn asking it to correct the submission. Configure the budget with
`maxRepairs` (default `1`):

```ts
const agent = createAgent({ model, maxRepairs: 2 });
```

If the budget is exhausted, `run` rejects with `IncompleteResultError`. A
structured run succeeds only after its result passes schema validation.

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
[Standard Schema](https://standardschema.dev): Zod 3.24+, Zod 4, Valibot,
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
Standard Schema validators still work; they validate the final output, with
generic guidance to the model.

## Without a schema: plain turns

Omit `schema` and the turn's streamed text **is** the output:

```ts
const reply = await agent.run({ prompt: 'Summarize our options.' });

reply.text; // the model's reply and plain-turn output
reply.data; // undefined (typed as undefined)
reply.finishReason; // why the turn ended, e.g. "stop"
```

Plain turns have no submission contract or repair loop. Use them for chat
replies; see [Building a chat agent](./chat-agent.md).

## Choosing per run

`schema` is a per-run decision, so one agent freely mixes both shapes: plain
conversational turns and structured extraction turns, even within the same
[thread](./threads.md).
