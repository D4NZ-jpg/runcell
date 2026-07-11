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
| `npm run example:10` | Multi-phase runs sharing one sandbox and thread             |

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

`example:09` demonstrates streaming, thread serialization, structured output,
and reuse of a caller-owned sandbox. It is a runnable version of the
[chat-agent guide](./chat-agent.md).

```bash
npm run example:09
```

## File output validation example

`example:08` seeds `feedback.txt`, asks the agent to create `report.md`, and
validates both the structured result and returned file.

```bash
npm run example:08
```
