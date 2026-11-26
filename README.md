# chronark

Per-second compute and settlement for agents. Wrap any command, pay only for the seconds it ran, and get back a receipt signed by the node that ran it.

```
$ chronark run --budget 2.00 -- python scraper.py
✓ session opened   0x7f3a…c21e
  rate 0.0004 USDG/s · budget 2.00 USDG · worker python · local node 0x3a93…306e
⧗ metered   412s  ████████████  0.1648 USDG
✓ receipt signed   ~/.chronark/receipts/0x7f3a….json
✓ settled 0.1648 USDG · refund 1.8352 USDG (simulated)
```

> **Two modes.** *Local* (default) runs the command on your own machine: seconds are metered and receipts signed for real, but no money moves (`"settlement": "simulated"`). *Cloud* (`--cloud <url>`) runs it in a locked-down sandbox on a Chronark node and pays from your balance on that node (`"settlement": "ledger"`). Balances are funded on chain through the ChronarkVault contract (or credited by the operator).

## Install

Needs Node 18.17 or newer. No dependencies.

```sh
# run it once
npx chronark --help

# or install the `chronark` command
npm install -g chronark
```

Straight from GitHub works too: `npx github:chronarklabs/chronark --help`.

## Cloud

Your account is your local ed25519 key (`~/.chronark/node.key`). There is no sign-up and no API key: every request is signed with that key.

```sh
export CHRONARK_CLOUD=https://<your node>
chronark account                 # prints your account id and balance
chronark run --worker python --budget 0.05 -- python -c "print(6*7)"
```

```
✓ session opened   0xe964…5e47  https://<your node>
  rate 0.0004 USDG/s · budget 0.05 USDG · worker python (python:3.12-slim) · node 0x7efd…af48
42
⧗ metered     1s  ░░░░░░░░░░░░  0.0004 USDG
✓ receipt signed   ~/.chronark/receipts/0xe964….json
✓ settled 0.0004 USDG · refund 0.0496 USDG (ledger)
```

- Opening a session holds the budget from your balance. Stopping it pays the seconds the sandbox was up (per started second) and returns the rest.
- When the budget runs out the sandbox is destroyed. An idle sandbox is closed after 5 minutes.
- Workers: `shell` (alpine 3.20), `python` (3.12), `node` (22). Each sandbox runs as uid 1000 with no network, a read-only root filesystem, a writable `/work` and `/tmp`, 512 MB of memory, 1 CPU and at most 256 processes.
- The receipt is signed by the node; `chronark verify` checks it, and the CLI refuses a receipt signed by a different node than the one that opened the session.
- Plain `http://` is only accepted for localhost.

### Funding an account

Deposits go through `ChronarkVault` (`contracts/`): `deposit(bytes20 account, uint256 amount)` pulls a 6-decimal stablecoin (USDG on Robinhood Chain by default) and emits `Deposit(account, from, amount)`. The node watches those events and credits the account once, after `CHRONARK_CONFIRMATIONS` blocks (default 3), keyed by transaction and log index so a rescan never pays twice.

- In a browser: `https://chronarkcloud.com/fund?account=<your account>` connects a wallet and does the approve and the deposit.
- From any wallet or script: approve the vault for the amount, then call `deposit(account, amount)`.

Deposits pay for compute on that node; they are not withdrawable back to the depositor. Unused session budget always returns to the account balance. The vault owner (the node operator) can withdraw what was paid in.

To deploy a vault: `cd contracts && npm install && npx hardhat test`, then
`DEPLOYER_KEY=… OWNER=0x… npx hardhat run scripts/deploy.js --network robinhood` and put the printed `CHRONARK_VAULT` / `CHRONARK_VAULT_FROM` into the node's service file.

### API

| | |
| --- | --- |
| `GET /v1/node` | node id, rate, workers (public) |
| `GET /v1/account` | balance, held funds, recent sessions |
| `POST /v1/sessions` `{worker, budget}` | open a sandbox, hold the budget |
| `POST /v1/sessions/:id/exec` `{cmd}` | run a command, output streamed as NDJSON |
| `POST /v1/sessions/:id/stop` | close, settle, return the signed receipt |
| `GET /v1/sessions/:id` | status, and the receipt once closed |
| `GET /v1/receipts/:id` | a closed session's receipt (public) |

Signed requests carry `x-chronark-key` (spki, base64), `x-chronark-ts` (ms), `x-chronark-nonce` and `x-chronark-sig`: an ed25519 signature over `METHOD\nPATH\nTS\nNONCE\nsha256(body)`. Requests older than 60 seconds or with a reused nonce are refused.

## Run a node

A node needs a Linux server of its own: strangers' code runs on it, inside containers. Do not use a machine that hosts anything else.

```sh
# on a fresh Ubuntu 22.04/24.04 server, with DNS for the hostname pointing at it
git clone https://github.com/chronarklabs/chronark.git && cd chronark
sudo DOMAIN=api.example.com bash deploy/install.sh

# credit an account (the id comes from `chronark account`)
sudo -u chronark CHRONARK_DATA=/var/lib/chronark node /opt/chronark/server/main.js credit 0x… 5.00
```

The script installs Docker, Node 22 and Caddy (HTTPS), creates a `chronark` system user, pulls the worker images, and starts `chronark.service`. Settings are environment variables in `deploy/chronark.service`: `CHRONARK_RATE`, `CHRONARK_NETWORK` (`none` by default), `CHRONARK_MEMORY`, `CHRONARK_CPUS`, `CHRONARK_MAX_SESSIONS`, `CHRONARK_MAX_PER_ACCOUNT`, `CHRONARK_IDLE`, `CHRONARK_MAX_BUDGET`. The ledger is SQLite at `/var/lib/chronark/ledger.db`; the node key sits next to it. If the node restarts with sessions open, it removes their sandboxes and refunds them in full.

To try it locally: `CHRONARK_RUNNER=docker node server/main.js` with Docker running (needs Node 22.13+ for `node:sqlite`).

## Commands

| command | what it does |
| --- | --- |
| `chronark run [--budget 2.00] [--worker name] [--cloud [url]] -- <cmd> [args]` | Runs the command, meters it by the second, stops it if the budget runs out, signs a receipt. Exits with the command's exit code (124 if the budget ran out). |
| `chronark quote <seconds> [--rate]` | What that many seconds cost. |
| `chronark receipts [--json]` | Every receipt on this machine, newest first. |
| `chronark verify <file \| session id>` | Checks a receipt's signature. Any edit to any field breaks it. |
| `chronark account [--cloud [url]]` | Your account id, and with a node, its balance and recent sessions. |
| `chronark whoami` | Your key's id and public key. |

Billing is per started second, in USDG with 6 decimals, computed in integers so it never rounds wrong. The default rate is 0.0004 USDG/s and the default budget 2.00 USDG.

## The receipt

```json
{
  "v": 1,
  "mode": "local",
  "session": "0x7f3a…c21e",
  "worker": "python",
  "seconds": 412,
  "rate": "0.000400 USDG/s",
  "budget": "2.000000 USDG",
  "paid": "0.164800 USDG",
  "refund": "1.835200 USDG",
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

`open` takes `budget` (USDG) or `seconds` (the same cap in time), plus `rate` and an `onTick` callback. `exec` takes a shell string or an `[cmd, ...args]` array and resolves with `{ code, signal, stdout, stderr }`.

## Develop

```sh
npm test                             # everything except the docker sandbox
CHRONARK_TEST_DOCKER=1 npm test      # with Docker running
cd contracts && npm install && npx hardhat test
# deposits end to end: (cd contracts && npx hardhat node) & CHRONARK_TEST_CHAIN=http://127.0.0.1:8545 npm test
```

The landing page is in `web/` and the Blender scene for its hero in `blender/scenes.py`.

## License

MIT
