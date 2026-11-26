// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SigilSeal} from "../src/SigilSeal.sol";

/// Deploys SigilSeal. Not run as part of the first build: anchoring is off until
/// the owner turns it on. SEALER is the address of the key the site seals with
/// (SIGIL_SEALER_KEY), a key used for nothing else; the deployer becomes the
/// contract's owner and can replace the sealer. Usage (the key is asked for at the prompt):
///   SEALER=0x... forge script script/DeploySigilSeal.s.sol --rpc-url $RPC_URL --interactives 1 --broadcast
/// Then set on the site: SIGIL_ANCHOR=on, SIGIL_ANCHOR_RPC_URL, SIGIL_SEAL_CONTRACT,
/// SIGIL_SEALER_KEY and SIGIL_CHAIN_READ_RPC (a public, read-only RPC of the same chain).
contract DeploySigilSeal is Script {
    function run() external returns (SigilSeal seals) {
        address sealerAddress = vm.envAddress("SEALER");
        require(sealerAddress != address(0), "SEALER is the zero address");
        vm.startBroadcast();
        seals = new SigilSeal(sealerAddress);
        vm.stopBroadcast();
        console2.log("SigilSeal", address(seals));
        console2.log("sealer", sealerAddress);
        console2.log("SIGIL_SEAL_CONTRACT", address(seals));
    }
}
