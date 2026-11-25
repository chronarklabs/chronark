const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ChronarkVault", () => {
  let usd, vault, owner, alice, bob;
  const ACC = "0xf49faf2199d49a6f09a59a00201aaaa1990b4a44";
  beforeEach(async () => {
    [owner, alice, bob] = await ethers.getSigners();
    usd = await (await ethers.getContractFactory("TestUSD")).deploy();
    vault = await (await ethers.getContractFactory("ChronarkVault")).deploy(await usd.getAddress(), owner.address);
    await usd.mint(alice.address, 10_000_000n); // 10.00
  });

  it("takes a deposit for an account and emits it", async () => {
    await usd.connect(alice).approve(await vault.getAddress(), 2_500_000n);
    await expect(vault.connect(alice).deposit(ACC, 2_500_000n))
      .to.emit(vault, "Deposit").withArgs(ACC, alice.address, 2_500_000n);
    expect(await usd.balanceOf(await vault.getAddress())).to.equal(2_500_000n);
    expect(await vault.totalDeposited()).to.equal(2_500_000n);
  });

  it("refuses zero amounts, the zero account and missing approval", async () => {
    await expect(vault.connect(alice).deposit(ACC, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.connect(alice).deposit(ethers.ZeroHash.slice(0, 42), 1)).to.be.revertedWithCustomError(vault, "ZeroAccount");
    await expect(vault.connect(alice).deposit(ACC, 1)).to.be.revertedWithCustomError(vault, "TransferFailed");
  });

  it("only the owner withdraws or hands over ownership", async () => {
    await usd.connect(alice).approve(await vault.getAddress(), 1_000_000n);
    await vault.connect(alice).deposit(ACC, 1_000_000n);
    await expect(vault.connect(bob).withdraw(bob.address, 1)).to.be.revertedWithCustomError(vault, "NotOwner");
    await expect(vault.withdraw(bob.address, 400_000n)).to.emit(vault, "Withdraw").withArgs(bob.address, 400_000n);
    expect(await usd.balanceOf(bob.address)).to.equal(400_000n);
    await expect(vault.connect(bob).setOwner(bob.address)).to.be.revertedWithCustomError(vault, "NotOwner");
    await vault.setOwner(bob.address);
    expect(await vault.owner()).to.equal(bob.address);
  });
});
