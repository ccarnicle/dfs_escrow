import { ethers, network } from "hardhat";

// Note: Typechain types are generated automatically by Hardhat after compilation.
// If you see errors with these imports, run `npx hardhat compile` first.
import { DFSEscrowManager, MockVaultFactory } from "../typechain-types";

async function main() {
  const [deployer] = await ethers.getSigners();
  let vaultFactoryAddress: string;

  console.log("Deploying DFSEscrowManager contracts with the account:", deployer.address);
  console.log("Network:", network.name);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

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

  // Deploy DFSEscrowManager, passing the determined VaultFactory address to the constructor.
  console.log("\nDeploying DFSEscrowManager...");
  const DFSEscrowManagerFactory = await ethers.getContractFactory("DFSEscrowManager");
  const dfsEscrowManager: DFSEscrowManager = await DFSEscrowManagerFactory.deploy(vaultFactoryAddress);
  await dfsEscrowManager.waitForDeployment();
  const dfsEscrowManagerAddress = await dfsEscrowManager.getAddress();

  console.log("DFSEscrowManager deployed to:", dfsEscrowManagerAddress);

  // Verify deployment
  console.log("\nVerifying deployment...");
  const deployedFactory = await dfsEscrowManager.yearnVaultFactory();
  const maxEntriesPerUser = await dfsEscrowManager.maxEntriesPerUser();
  console.log("✓ VaultFactory address:", deployedFactory);
  console.log("✓ Max entries per user:", maxEntriesPerUser.toString());

  console.log("\nDeployment complete!");
  console.log("====================================================");
  console.log("DEPLOYMENT SUMMARY");
  console.log("====================================================");
  console.log("Network:", network.name);
  console.log("DFSEscrowManager:", dfsEscrowManagerAddress);
  console.log("VaultFactory:", vaultFactoryAddress);
  
  if (network.name === 'flowMainnet') {
    console.log("\nFor frontend .env file:");
    console.log(`NEXT_PUBLIC_EVM_ESCROW_ADDRESS=${dfsEscrowManagerAddress}`);
    console.log(`NEXT_PUBLIC_PYUSD_ADDRESS=0x99af3eea856556646c98c8b9b2548fe815240750`);
  } else {
    console.log("\nFor frontend .env.local file:");
    console.log(`NEXT_PUBLIC_EVM_ESCROW_ADDRESS_TESTNET=${dfsEscrowManagerAddress}`);
    console.log(`NEXT_PUBLIC_PYUSD_ADDRESS_TESTNET=0xd7d43ab7b365f0d0789aE83F4385fA710FfdC98F`);
  }
  
  console.log("\n====================================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
