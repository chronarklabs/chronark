// Watches a ChronarkVault on chain and credits each Deposit to the ledger, once, after N confirmations.
// Plain JSON-RPC (eth_blockNumber, eth_getLogs), no web3 library.
// keccak256("Deposit(bytes20,address,uint256)"), checked against the compiled contract in contracts/test
export const DEPOSIT_TOPIC = "0x6c362c23daa171c50a02f9217f2c1a49915ed78f671d2114ecb1896fc7462fa1";

export function watchDeposits({ ledger, rpc, vault, from = 0, confirmations = 3, every = 15_000, chunk = 2_000, log = () => {} }) {
  let id = 0, timer = null, stopped = false;
  const call = async (method, params) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  const key = `vault:${vault.toLowerCase()}:next`;

  async function scan() {
    const head = parseInt(await call("eth_blockNumber", []), 16) - confirmations;
    let next = Number(ledger.meta(key) ?? from);
    let credited = 0;
    while (next <= head) {
      const to = Math.min(head, next + chunk - 1);
      const logs = await call("eth_getLogs", [{ address: vault, topics: [DEPOSIT_TOPIC], fromBlock: "0x" + next.toString(16), toBlock: "0x" + to.toString(16) }]);
      for (const l of logs) {
        if (l.removed) continue;
        const account = "0x" + l.topics[1].slice(2, 42);           // bytes20 indexed: left-aligned in the topic
        const sender = "0x" + l.topics[2].slice(26);
        const amount = BigInt(l.data.slice(0, 66));
        const ok = ledger.deposit({ id: `${l.transactionHash}:${parseInt(l.logIndex, 16)}`, account, sender, amount, tx: l.transactionHash, block: parseInt(l.blockNumber, 16) });
        if (ok) { credited++; log(`deposit ${amount} to ${account.slice(0, 10)} tx ${l.transactionHash.slice(0, 12)}`); }
      }
      next = to + 1;
      ledger.setMeta(key, next);
    }
    return credited;
  }
  async function loop() {
    if (stopped) return;
    try { await scan(); } catch (e) { log("deposit watcher: " + e.message); }
    if (!stopped) { timer = setTimeout(loop, every); timer.unref?.(); }
  }
  return { scan, start() { loop(); return this; }, stop() { stopped = true; clearTimeout(timer); } };
}
