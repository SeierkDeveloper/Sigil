// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SigilSeal} from "../src/SigilSeal.sol";

/// Deploys SigilSeal. Not run as part of the first build: anchoring is off until
/// the owner turns it on. Usage (the key is asked for at the prompt):
///   SEALER=0x... forge script script/DeploySigilSeal.s.sol --rpc-url $RPC_URL --interactives 1 --broadcast
contract DeploySigilSeal is Script {
    function run() external returns (SigilSeal seals) {
        address sealerAddress = vm.envAddress("SEALER");
        vm.startBroadcast();
        seals = new SigilSeal(sealerAddress);
        vm.stopBroadcast();
        console2.log("SigilSeal", address(seals));
        console2.log("sealer", sealerAddress);
    }
}
