// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SigilSelfRegistry} from "../src/SigilSelfRegistry.sol";
import {SigilSelfWallet} from "../src/SigilSelfWallet.sol";

/// Deploys the registry of AI selves once for a site. Not run as part of the
/// build: the Identity tab works off chain until an address is configured.
/// Usage (the key is asked for at the prompt):
///   forge script script/DeploySigilSelf.s.sol:DeploySigilSelfRegistry --rpc-url $RPC_URL --interactives 1 --broadcast
contract DeploySigilSelfRegistry is Script {
    function run() external returns (SigilSelfRegistry registry) {
        vm.startBroadcast();
        registry = new SigilSelfRegistry();
        vm.stopBroadcast();
        console2.log("SigilSelfRegistry", address(registry));
    }
}

/// Deploys one self wallet for one owner. OWNER is the owner's own address and
/// SELF_KEY the self key address shown in the Identity tab. Both are named
/// explicitly rather than taken from the sender.
///   OWNER=0x... SELF_KEY=0x... forge script script/DeploySigilSelf.s.sol:DeploySigilSelfWallet --rpc-url $RPC_URL --interactives 1 --broadcast
contract DeploySigilSelfWallet is Script {
    function run() external returns (SigilSelfWallet wallet) {
        address owner = vm.envAddress("OWNER");
        address selfKey = vm.envAddress("SELF_KEY");
        vm.startBroadcast();
        wallet = new SigilSelfWallet(owner, selfKey);
        vm.stopBroadcast();
        console2.log("SigilSelfWallet", address(wallet));
        console2.log("owner", owner);
        console2.log("self key", selfKey);
    }
}
