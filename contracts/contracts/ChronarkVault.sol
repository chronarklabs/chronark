// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ChronarkVault
/// @notice Prepaid credit for a Chronark Cloud node. Anyone deposits a stablecoin for a Chronark account
///         (the 20-byte id printed by `chronark account`); the node watches Deposit events and credits that
///         account's balance. Deposits are payment for compute, not custody: they go to the node operator,
///         who can withdraw them. There is no on-chain refund path in this version.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract ChronarkVault {
    IERC20 public immutable token;
    address public owner;
    uint256 public totalDeposited;

    event Deposit(bytes20 indexed account, address indexed from, uint256 amount);
    event Withdraw(address indexed to, uint256 amount);
    event OwnerChanged(address indexed previous, address indexed next);

    error ZeroAmount();
    error ZeroAccount();
    error NotOwner();
    error TransferFailed();

    constructor(IERC20 token_, address owner_) {
        token = token_;
        owner = owner_;
        emit OwnerChanged(address(0), owner_);
    }

    /// @notice Pays `amount` of the token (approve this vault first) into the Chronark account `account`.
    function deposit(bytes20 account, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (account == bytes20(0)) revert ZeroAccount();
        _call(abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
        totalDeposited += amount;
        emit Deposit(account, msg.sender, amount);
    }

    function withdraw(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _call(abi.encodeCall(IERC20.transfer, (to, amount)));
        emit Withdraw(to, amount);
    }

    function setOwner(address next) external {
        if (msg.sender != owner) revert NotOwner();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    /// @dev Works with tokens that return a bool and with those that return nothing.
    function _call(bytes memory data) private {
        (bool ok, bytes memory ret) = address(token).call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
