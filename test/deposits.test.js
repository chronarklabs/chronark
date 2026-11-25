// End to end against a local chain: CHRONARK_TEST_CHAIN=http://127.0.0.1:8545 (cd contracts && npx hardhat node)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { openLedger } from "../server/ledger.js";
import { watchDeposits } from "../server/deposits.js";

const RPC = process.env.CHRONARK_TEST_CHAIN;
test("vault deposits are credited once, after confirmations", { skip: !RPC && "set CHRONARK_TEST_CHAIN to a local hardhat node" }, async () => {
  const require = createRequire(new URL("../contracts/package.json", import.meta.url));
  const { ethers } = require("ethers");
  const art = (n) => require(`./artifacts/contracts/${n}.sol/${n}.json`);
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { pollingInterval: 200 });
  const [owner, alice] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
  const usd = await new ethers.ContractFactory(art("TestUSD").abi, art("TestUSD").bytecode, owner).deploy();
  const vault = await new ethers.ContractFactory(art("ChronarkVault").abi, art("ChronarkVault").bytecode, owner).deploy(await usd.getAddress(), await owner.getAddress());
  const from = (await vault.deploymentTransaction().wait()).blockNumber;
  await (await usd.mint(await alice.getAddress(), 5_000_000n)).wait();
  const acc = "0x" + "ab".repeat(20);
  await (await usd.connect(alice).approve(await vault.getAddress(), 3_000_000n)).wait();
  await (await vault.connect(alice).deposit(acc, 1_250_000n)).wait();
  await (await vault.connect(alice).deposit(acc, 750_000n)).wait();

  const ledger = openLedger(":memory:");
  const w = watchDeposits({ ledger, rpc: RPC, vault: await vault.getAddress(), from, confirmations: 1 });
  // the second deposit is in the newest block, 0 confirmations: it must wait
  assert.equal(await w.scan(), 1);
  assert.equal(ledger.account(acc).balance, 1_250_000n);
  await provider.send("evm_mine", []);
  assert.equal(await w.scan(), 1);
  assert.equal(ledger.account(acc).balance, 2_000_000n);
  // a rescan from scratch never credits twice
  ledger.setMeta(`vault:${(await vault.getAddress()).toLowerCase()}:next`, from);
  assert.equal(await w.scan(), 0);
  assert.equal(ledger.account(acc).balance, 2_000_000n);
  assert.equal(ledger.deposits(acc).length, 2);
});
