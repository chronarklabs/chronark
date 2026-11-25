// Deploys ChronarkVault. Run by the operator with their own deployer key:
//   cd contracts && DEPLOYER_KEY=… TOKEN=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 OWNER=0x… npx hardhat run scripts/deploy.js --network robinhood
// TOKEN defaults to USDG on Robinhood Chain. OWNER is who can withdraw (use a wallet you keep offline).
const { ethers } = require("hardhat");
async function main() {
  const token = process.env.TOKEN || "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const owner = process.env.OWNER;
  if (!ethers.isAddress(owner || "")) throw new Error("set OWNER to the address that may withdraw");
  const v = await (await ethers.getContractFactory("ChronarkVault")).deploy(token, owner);
  await v.waitForDeployment();
  const rc = await v.deploymentTransaction().wait();
  console.log(`ChronarkVault ${await v.getAddress()} · token ${token} · owner ${owner} · block ${rc.blockNumber}`);
  console.log(`node env: CHRONARK_VAULT=${await v.getAddress()} CHRONARK_VAULT_FROM=${rc.blockNumber}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
