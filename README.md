# Agent Crystalball

Speculative tool execution: memoize calls, predict the next tool with a Markov prophecy, and warm the cache before the agent asks.

TypeScript package `agent-crystalball`.

## Install

```sh
npm install github:theAliCanAcar/agent-crystalball#main
```

## How to use

```ts
import { tool } from 'agent-tools';
import { memoize } from 'agent-crystalball';
import { z } from 'zod';

const lookup = tool({
  name: 'lookup',
  description: 'Lookup a key',
  schema: z.object({ key: z.string() }),
  execute: async ({ key }) => ({ key, value: 1 }),
});

const cached = memoize(lookup, 30_000);
console.log(await cached.execute({ key: 'a' }, {}));
console.log(await cached.execute({ key: 'a' }, {}));
```

## Use cases

### 1. Skip duplicate tool calls

- **Scenario:** An agent asks for the same lookup twice in one run.
- **Outcome:** memoize/createOracle caches results within a TTL.

### 2. Warm likely next tools

- **Scenario:** Tool sequences are predictable.
- **Outcome:** Use prophecy/warm so hot paths are already cached.

## Dependencies

- `agent-tools`: `github:theAliCanAcar/agent-tools#main`

## Scripts

```sh
npm install
npm run build
```

## Notes

- Keep API keys in environment variables or a gitignored `.env`. Never commit secrets.
- Side-effecting tools should go through approval when used with `agent-approval`.
- Related packages live in separate repositories under [theAliCanAcar](https://github.com/theAliCanAcar).

## License

MIT
