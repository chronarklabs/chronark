#!/bin/bash
# Deploy ChronarkVault to Robinhood Chain and connect it to the chronarkcloud.com node in one go.
# Run from your own machine: ./contracts/deploy-and-connect.sh
# The deployer key is read without echo, kept only in this process, and never written to disk or sent to the server.
set -euo pipefail
cd "$(dirname "$0")"
HOST="${CHRONARK_SSH:-root@203.194.113.116}"

read -r -p "Owner address (who may withdraw, 0x…): " OWNER
[[ "$OWNER" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "That is not an address."; exit 2; }
read -r -s -p "Deployer private key (hidden, needs a little ETH on Robinhood Chain for gas): " DEPLOYER_KEY; echo
export DEPLOYER_KEY OWNER
trap 'unset DEPLOYER_KEY' EXIT

[ -d node_modules ] || npm ci --silent
echo "Deploying…"
OUT=$(npx hardhat run scripts/deploy.js --network robinhood 2>&1) || { echo "$OUT" | grep -v -i key; exit 1; }
unset DEPLOYER_KEY
echo "$OUT" | grep ChronarkVault
VAULT=$(echo "$OUT" | sed -nE 's/.*CHRONARK_VAULT=(0x[0-9a-fA-F]{40}).*/\1/p')
FROM=$(echo "$OUT" | sed -nE 's/.*CHRONARK_VAULT_FROM=([0-9]+).*/\1/p')
[ -n "$VAULT" ] && [ -n "$FROM" ] || { echo "Could not read the vault address from the deploy output."; exit 1; }

echo "Connecting $VAULT (block $FROM) to the node…"
ssh "$HOST" "/root/chronark-vault-connect.sh $VAULT $FROM"
echo
echo "Done. Deposits: https://chronarkcloud.com/fund"
