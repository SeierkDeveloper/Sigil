#!/bin/sh
# The contracts on a test network, before any real deploy: deploys SigilSeal and
# the registry with the repository's scripts and checks a seal round trip.
# Asks for the deployer key without echoing it; refuses a main network.
set -eu
cd "$(dirname "$0")/../../contracts"
export PATH="$HOME/.foundry/bin:$PATH"
: "${SIGIL_TESTNET_RPC:?Set SIGIL_TESTNET_RPC to a test network RPC address}"
CHAIN=$(cast chain-id --rpc-url "$SIGIL_TESTNET_RPC")
case "$CHAIN" in 1|10|56|137|8453|42161|43114) echo "Chain $CHAIN is a main network. This check runs on test networks only."; exit 1;; esac
printf "Deployer key for the test network (not shown): "
stty -echo; read -r KEY; stty echo; echo
SEALER=$(cast wallet address --private-key "$KEY")
echo "Deployer and sealer: $SEALER on chain $CHAIN"
SEALER="$SEALER" forge script script/DeploySigilSeal.s.sol --rpc-url "$SIGIL_TESTNET_RPC" --private-key "$KEY" --broadcast
forge script script/DeploySigilSelf.s.sol:DeploySigilSelfRegistry --rpc-url "$SIGIL_TESTNET_RPC" --private-key "$KEY" --broadcast
echo "Deployed. Note the addresses above, then follow docs/GO-LIVE-CHECKS.md, Contracts, to seal one hour and verify it."
unset KEY
