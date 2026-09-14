// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../../contracts/ERC20Swap.sol";
import "../../contracts/TestERC20.sol";
import "forge-std/Test.sol";

// What this proves: the EVM half of a Bitcoin swap behaves — lock holds funds,
// the preimage releases them to the claimer only, the locker gets them back after
// the timeout and not before. Every refusal below is a case where real money would
// otherwise move the wrong way.
contract ERC20SwapTest is Test {
    ERC20Swap internal swapper;
    TestERC20 internal token;

    bytes32 internal preimage = bytes32(uint256(0xBEEF));
    bytes32 internal preimageHash;
    address internal locker = address(0xA11CE);
    address internal claimer = address(0xC1A1);
    uint256 internal amount = 1_000_000; // 1 USDC-shaped unit
    uint256 internal timelock;

    function setUp() public {
        swapper = new ERC20Swap();
        token = new TestERC20("Test USDC", "TUSDC", 6, amount);
        token.transfer(locker, amount);
        preimageHash = sha256(abi.encodePacked(preimage));
        timelock = block.number + 100;
    }

    function _lock() internal returns (bytes32) {
        vm.startPrank(locker);
        token.approve(address(swapper), amount);
        swapper.lock(preimageHash, amount, address(token), claimer, timelock);
        vm.stopPrank();
        return swapper.hashValues(preimageHash, amount, address(token), claimer, locker, timelock);
    }

    function test_lock_holds_funds() public {
        bytes32 h = _lock();
        assertTrue(swapper.swaps(h), "swap not recorded");
        assertEq(token.balanceOf(address(swapper)), amount, "contract did not receive tokens");
        assertEq(token.balanceOf(locker), 0, "locker kept tokens");
    }

    function test_lock_twice_reverts() public {
        _lock();
        vm.startPrank(locker);
        token.approve(address(swapper), amount);
        vm.expectRevert("ERC20Swap: swap exists already");
        swapper.lock(preimageHash, amount, address(token), claimer, timelock);
        vm.stopPrank();
    }

    // claim() pays msg.sender: only the named claimer calling it finds the swap.
    // That is the whole anti-theft property, so every claim test pranks the claimer.
    function test_claim_pays_claimer_not_locker() public {
        _lock();
        uint256 before = token.balanceOf(claimer);
        vm.prank(claimer);
        swapper.claim(preimage, amount, address(token), locker, timelock);
        assertEq(token.balanceOf(claimer) - before, amount, "claimer not paid");
        assertEq(token.balanceOf(address(swapper)), 0, "contract kept tokens");
    }

    function test_claim_twice_reverts() public {
        _lock();
        vm.prank(claimer);
        swapper.claim(preimage, amount, address(token), locker, timelock);
        vm.prank(claimer);
        vm.expectRevert("ERC20Swap: swap has no tokens locked in the contract");
        swapper.claim(preimage, amount, address(token), locker, timelock);
    }

    function test_wrong_preimage_claims_nothing() public {
        _lock();
        vm.expectRevert("ERC20Swap: swap has no tokens locked in the contract");
        swapper.claim(bytes32(uint256(0xDEAD)), amount, address(token), locker, timelock);
        assertEq(token.balanceOf(address(swapper)), amount, "funds moved on wrong preimage");
    }

    function test_stranger_claim_pays_stranger_not_claimer() public {
        // claim() sends to msg.sender as claimAddress; a stranger calling it with the
        // preimage computes a different value hash and finds no swap. Prove it.
        _lock();
        address stranger = address(0xBAD);
        vm.prank(stranger);
        vm.expectRevert("ERC20Swap: swap has no tokens locked in the contract");
        swapper.claim(preimage, amount, address(token), locker, timelock);
        assertEq(token.balanceOf(stranger), 0, "stranger got paid");
    }

    function test_refund_before_timeout_reverts() public {
        _lock();
        vm.prank(locker);
        vm.expectRevert("ERC20Swap: swap has not timed out yet");
        swapper.refund(preimageHash, amount, address(token), claimer, timelock);
        assertEq(token.balanceOf(address(swapper)), amount, "funds moved before timeout");
    }

    function test_refund_after_timeout_pays_locker() public {
        _lock();
        vm.roll(timelock);
        vm.prank(locker);
        swapper.refund(preimageHash, amount, address(token), claimer, timelock);
        assertEq(token.balanceOf(locker), amount, "locker not refunded");
    }

    function test_refund_after_claim_reverts() public {
        _lock();
        vm.prank(claimer);
        swapper.claim(preimage, amount, address(token), locker, timelock);
        vm.roll(timelock);
        vm.prank(locker);
        vm.expectRevert("ERC20Swap: swap has no tokens locked in the contract");
        swapper.refund(preimageHash, amount, address(token), claimer, timelock);
    }
}
