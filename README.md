# chronark

Per-second compute and settlement for agents. Wrap any command, pay only for the seconds it ran, and get back a receipt signed by the node that ran it.

```
$ chronark run --budget 2.00 -- python scraper.py
✓ session opened   0x7f3a…c21e
  rate 0.0004 USDC/s · budget 2.00 USDC · worker python · local node 0x3a93…306e
⧗ metered   412s  ████████████  0.1648 USDC
✓ receipt signed   ~/.chronark/receipts/0x7f3a….json
✓ settled 0.1648 USDC · refund 1.8352 USDC (simulated)
```

> **Status: local mode.** This release meters and signs for real, but the worker is your own machine and no money moves. Receipts say `"settlement": "simulated"`. Remote workers and on-chain settlement come later; nothing here asks for a wallet, a key or a deposit.

## Install

Needs Node 18.17 or newer. No dependencies.

```sh
# run it once
npx chronark --help

# or install the `chronark` command
npm install -g chronark
```

Straight from GitHub works too: `npx github:chronarklabs/chronark --help`.

## Commands

| command | what it does |
| --- | --- |
| `chronark run [--budget 2.00] [--rate 0.0004] [--worker name] -- <cmd> [args]` | Runs the command, meters it by the second, stops it if the budget runs out, signs a receipt. Exits with the command's exit code (124 if the budget ran out). |
| `chronark quote <seconds> [--rate]` | What that many seconds cost. |
| `chronark receipts [--json]` | Every receipt on this machine, newest first. |
| `chronark verify <file \| session id>` | Checks a receipt's signature. Any edit to any field breaks it. |
| `chronark whoami` | This node's id and public key. |

Billing is per started second, in USDC with 6 decimals, computed in integers so it never rounds wrong. The default rate is 0.0004 USDC/s and the default budget 2.00 USDC.

## The receipt

```json
{
  "v": 1,
  "mode": "local",
  "session": "0x7f3a…c21e",
  "worker": "python",
  "seconds": 412,
  "rate": "0.000400 USDC/s",
  "budget": "2.000000 USDC",
  "paid": "0.164800 USDC",
  "refund": "1.835200 USDC",
  "status": "completed",
  "settlement": "simulated",
  "execs": [{ "cmd": "python scraper.py", "code": 0, "signal": null }],
  "output": "sha256:91c7…",
  "node": { "id": "0x3a93…306e", "pub": "MCowBQYDK2VwAyEA…" },
  "sig": "5d0a…"
}
```

- `output` is the sha256 of everything the command wrote to stdout and stderr, in order.
- `sig` is an ed25519 signature over the canonical JSON of every other field (keys sorted, no whitespace).
- `node.id` is the first 20 bytes of sha256 of the node's public key, so a receipt can't swap in another key.

The node key is created on first use at `~/.chronark/node.key` with mode 0600 and is never printed. Set `CHRONARK_HOME` to keep state somewhere else.

## SDK

```js
import chronark from "chronark"; // npm install chronark

const session = await chronark.open({ worker: "python", seconds: 600 });
const out = await session.exec("python main.py");
const receipt = await session.stop();

chronark.verifyReceipt(receipt); // { ok: true }
```

`open` takes `budget` (USDC) or `seconds` (the same cap in time), plus `rate` and an `onTick` callback. `exec` takes a shell string or an `[cmd, ...args]` array and resolves with `{ code, signal, stdout, stderr }`.

## Develop

```sh
npm test
```

The landing page is in `web/` and the Blender scene for its hero in `blender/scenes.py`.

## License

MIT
