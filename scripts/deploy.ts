import { ethers, network } from "hardhat";

// Note: Typechain types are generated automatically by Hardhat after compilation.
// If you see errors with these imports, run `npx hardhat compile` first.
import { EscrowManager, MockVaultFactory } from "../typechain-types";

async function main() {
  const [deployer] = await ethers.getSigners();
  let vaultFactoryAddress: string;

  console.log("Deploying contracts with the account:", deployer.address);
  console.log("Network:", network.name);


  if (network.name === "flowMainnet") {
    // On mainnet, use the official Yearn VaultFactory address.
    vaultFactoryAddress = "0x770D0d1Fb036483Ed4AbB6d53c1C88fb277D812F";
    console.log(`\nUsing official Yearn VaultFactory on Mainnet: ${vaultFactoryAddress}`);
  } else {
    // For local testing or testnet, deploy our mock version.
    console.log("\nDeploying MockVaultFactory...");
    const MockVaultFactoryFactory = await ethers.getContractFactory("MockVaultFactory");
    const mockVaultFactory: MockVaultFactory = await MockVaultFactoryFactory.deploy();
    await mockVaultFactory.waitForDeployment();
    vaultFactoryAddress = await mockVaultFactory.getAddress();
    console.log("MockVaultFactory deployed to:", vaultFactoryAddress);
  }

  // Deploy EscrowManager, passing the determined VaultFactory address to the constructor.
  console.log("\nDeploying EscrowManager...");
  const EscrowManagerFactory = await ethers.getContractFactory("EscrowManager");
  const escrowManager: EscrowManager = await EscrowManagerFactory.deploy(vaultFactoryAddress);
  await escrowManager.waitForDeployment();
  const escrowManagerAddress = await escrowManager.getAddress();

  console.log("EscrowManager deployed to:", escrowManagerAddress);

  console.log("\nDeployment complete!");
  console.log("----------------------------------------------------");
  if (network.name === 'flowMainnet') {
    console.log("Update NEXT_PUBLIC_EVM_ESCROW_ADDRESS in the frontend .env file with this address:");
    console.log(escrowManagerAddress);
  } else {
    console.log("To use these contracts in the frontend, update the .env.local file with these addresses.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
