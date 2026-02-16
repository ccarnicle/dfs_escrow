import { ethers, network } from "hardhat";

// Note: Typechain types are generated automatically by Hardhat after compilation.
// If you see errors with these imports, run `npx hardhat compile` first.
import { DFSEscrowManager, MockVaultFactory } from "../typechain-types";

const MAINNET_NETWORKS = ["flowMainnet", "arbitrumOne", "base"];
const REAL_VAULT_FACTORY_ADDRESSES: Record<string, string> = {
  flowMainnet: "0x770D0d1Fb036483Ed4AbB6d53c1C88fb277D812F",
  // Add Arbitrum/Base Yearn VaultFactory addresses when known
  // arbitrumOne: "0x...",
  // base: "0x...",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  let vaultFactoryAddress: string;

  console.log("Deploying DFSEscrowManager contracts with the account:", deployer.address);
  console.log("Network:", network.name);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  if (MAINNET_NETWORKS.includes(network.name) && REAL_VAULT_FACTORY_ADDRESSES[network.name]) {
    vaultFactoryAddress = REAL_VAULT_FACTORY_ADDRESSES[network.name];
    console.log(`\nUsing official Yearn VaultFactory on ${network.name}: ${vaultFactoryAddress}`);
  } else {
    // Deploy MockVaultFactory for testnets and networks without Yearn
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
  } else if (network.name === 'arbitrumSepolia') {
    console.log("\nFor frontend .env (Arbitrum Sepolia):");
    console.log(`NEXT_PUBLIC_EVM_ESCROW_ADDRESS_ARB_SEPOLIA=${dfsEscrowManagerAddress}`);
    console.log(`NEXT_PUBLIC_PYUSD_ADDRESS_ARB_SEPOLIA=0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1`);
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
