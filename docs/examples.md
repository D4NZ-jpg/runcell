# Examples

The examples in `examples/` are compile-checked and runnable.

| Command              | Demonstrates                                                |
| -------------------- | ----------------------------------------------------------- |
| `npm run example:01` | Minimal `createAgent()` + `agent.run()`                     |
| `npm run example:02` | Structured output validation and incomplete-result handling |
| `npm run example:03` | Passing files into the sandbox                              |
| `npm run example:04` | Text, tool, file-change, repair, and finish events          |
| `npm run example:05` | Host-side custom tools                                      |
| `npm run example:06` | Credential modes                                            |
| `npm run example:07` | Minimal shared credential store                             |
| `npm run example:08` | Structured output plus returned file validation             |
| `npm run example:09` | Chat agent: streaming, thread persistence, shared sandbox   |

Run all examples:

```bash
RUNCELL_EXAMPLE_CREDENTIALS=local npm run examples:run
```

Example environment variables:

```txt
RUNCELL_EXAMPLE_CREDENTIALS=local
RUNCELL_EXAMPLE_MODEL=anthropic/claude-sonnet-4-5
```

Supported example credential values:

```txt
local
env
agentDir:/path/to/agent-dir
```

## Chat agent example

`example:09` is the [chat-agent guide](./chat-agent.md) condensed into one
script:

1. stream a plain chat turn (no schema) into stdout;
2. serialize the thread to JSON and rebuild it, like a server between requests;
3. prove the memory survived with a second turn;
4. run a structured turn on the same conversation;
5. read a file the agent wrote, straight off the caller-owned sandbox.

```bash
npm run example:09
```

## File output validation example

`example:08` shows a more complete pattern:

1. seed `feedback.txt` into the sandbox;
2. ask the agent to create `report.md`;
3. validate structured data with a Standard Schema-compatible validator;
4. find `report.md` in `result.files`;
5. decode file bytes;
6. parse a final object through another schema.

```bash
npm run example:08
```
