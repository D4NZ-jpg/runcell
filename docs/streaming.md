# Streaming

`agent.stream()` is `run()` with a live text feed. It returns immediately with
two things:

```ts
const { textStream, result } = agent.stream({ prompt: 'Explain the plan.' });

for await (const delta of textStream) {
  process.stdout.write(delta); // tokens as the model produces them
}

const final = await result; // the same RunResult run() would return
```

- `textStream` is an `AsyncIterable<string>` of the model's text deltas.
- `result` is a promise for the final `RunResult`. Always await it, even if you
  only need the stream. Awaiting it finalizes the turn, surfaces errors, and
  commits conversation state when using a thread.

## With and without a schema

Streaming works for both run shapes:

```ts
// Chat turn: the stream IS the reply.
const chat = agent.stream({ prompt, thread });

// Structured task: the stream is progress narration; await result for data.
const task = agent.stream({ prompt, schema });
for await (const delta of task.textStream) ui.showThinking(delta);
const { data } = await task.result; // validated payload
```

## Piping to a browser (SSE)

`textStream` maps directly onto a web-standard `ReadableStream`:

```ts
export async function POST(req: Request): Promise<Response> {
  const { prompt } = await req.json();
  const { textStream, result } = agent.stream({ prompt });

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const delta of textStream) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(delta)}\n\n`),
        );
      }
      await result;
      controller.close();
    },
  });

  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
```

The full server pattern, with threads and persistence, is in
[Building a chat agent](./chat-agent.md).

## Run events

`textStream` carries text only. Agent-level and per-run `events` callbacks deliver tool calls, tool results,
file changes, repairs, and errors during streamed and non-streamed runs:

```ts
const agent = createAgent({
  model,
  events: {
    onToolCall: call => ui.showTool(call.name),
    onFileChange: file => ui.showFile(file.path),
  },
});
```

See [Files, tools, and events](./files-tools-events.md) for the full list.

## Errors

If the run fails, the stream simply ends and `result` rejects. Handle errors
where you `await result`; a `try`/`catch` around only the `for await` loop is
not enough.
