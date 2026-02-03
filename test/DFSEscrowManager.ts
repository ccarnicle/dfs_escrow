import { ethers } from "hardhat";
import { EventLog } from "ethers";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { DFSEscrowManager, MockToken } from "../typechain-types";
import { MockYearnVault } from "../typechain-types/contracts/mocks/MockYearnVault";

// Main test suite for DFSEscrowManager
describe("DFSEscrowManager", function () {
    // Fixture to set up the initial state for each test
    async function deployDFSEscrowManagerFixture() {
        const [owner, organizer, participant1, participant2, contributor] = await ethers.getSigners();

        const MockToken = await ethers.getContractFactory("MockToken");
        const mockToken = await MockToken.deploy();

        const MockVaultFactory = await ethers.getContractFactory("MockVaultFactory");
        const mockVaultFactory = await MockVaultFactory.deploy();
        const mockFactoryAddress = await mockVaultFactory.getAddress();

        const DFSEscrowManager = await ethers.getContractFactory("DFSEscrowManager");
        const dfsEscrowManager = await DFSEscrowManager.deploy(mockFactoryAddress);

        return {
            dfsEscrowManager,
            mockToken,
            mockVaultFactory,
            owner,
            organizer,
            participant1,
            participant2,
            contributor,
        };
    }

    describe("Deployment", function () {
        it("Should deploy with the correct initial state", async function () {
            const { dfsEscrowManager, mockVaultFactory } = await loadFixture(deployDFSEscrowManagerFixture);
            const factoryAddress = await mockVaultFactory.getAddress();
            expect(await dfsEscrowManager.yearnVaultFactory()).to.equal(factoryAddress);
            expect(await dfsEscrowManager.nextEscrowId()).to.equal(0);
            expect(await dfsEscrowManager.maxEntriesPerUser()).to.equal(1000);
        });
    });

    describe("createEscrow", function () {
        it("Should create an escrow and correctly configure the new Yearn vault", async function () {
            const { dfsEscrowManager, mockToken, organizer } = await loadFixture(
                deployDFSEscrowManagerFixture
            );

            const tokenAddress = await mockToken.getAddress();
            const dues = ethers.parseUnits("1", 6); // PYUSD has 6 decimals
            const endTime = (await time.latest()) + (2 * 24 * 3600); // 2 days from now

            // For DFS, organizer does NOT need funds/approval since they don't auto-join
            const tx = await dfsEscrowManager.connect(organizer).createEscrow(tokenAddress, dues, endTime, "Test Vault", 10);
            const receipt = await tx.wait();

            // Find the event to get the new vault's address
            const eventLog = receipt?.logs?.find(
                (log: any) => log.fragment && log.fragment.name === 'EscrowCreated'
            ) as EventLog | undefined;
            
            expect(eventLog, "EscrowCreated event not found").to.not.be.undefined;
            if (!eventLog) throw new Error("EscrowCreated event not found");
            const vaultAddress = eventLog.args.yearnVault;
            
            expect(vaultAddress).to.be.properAddress;

            // Get an instance of the new mock vault to check its state
            const mockVault = await ethers.getContractAt("MockYearnVault", vaultAddress) as MockYearnVault;

            // 1. Verify the DFSEscrowManager set the correct role on the vault
            const escrowManagerAddress = await dfsEscrowManager.getAddress();
            expect(await mockVault.roles(escrowManagerAddress)).to.equal(256); // DEPOSIT_LIMIT_MANAGER role

            // 2. Verify the DFSEscrowManager set the correct deposit limit on the vault
            expect(await mockVault.depositLimit()).to.equal(ethers.MaxUint256);

            // Check the details of the created escrow
            const details = await dfsEscrowManager.getEscrowDetails(0);
            expect(details.organizer).to.equal(organizer.address);
            expect(details.token).to.equal(tokenAddress);
            expect(details.dues).to.equal(dues);
            expect(details.leagueName).to.equal("Test Vault");

            // Check tracking arrays
            expect(await dfsEscrowManager.getCreatedEscrows(organizer.address)).to.deep.equal([0n]);
            expect(await dfsEscrowManager.getActiveEscrowIds()).to.deep.equal([0n]);
            
            // Verify organizer did NOT auto-join
            expect(await dfsEscrowManager.getParticipants(0)).to.be.empty;
            expect(await dfsEscrowManager.getJoinedEscrows(organizer.address)).to.be.empty; // Organizer didn't join, only created
        });

        it("Organizer does NOT automatically join upon creation", async function () {
            const { dfsEscrowManager, mockToken, organizer } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            
            // No need to mint/approve for organizer since they don't auto-join
            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(), 
                dues, 
                (await time.latest()) + (2 * 24 * 3600), 
                "Join Vault", 
                5
            );

            const details = await dfsEscrowManager.getEscrowDetails(0);
            const vault = await ethers.getContractAt("MockYearnVault", details.yearnVault);

            // Verify no funds were deposited (organizer didn't join)
            expect(await vault.balanceOf(await dfsEscrowManager.getAddress())).to.equal(0);
            expect(await dfsEscrowManager.getParticipants(0)).to.be.empty;
            expect(await dfsEscrowManager.getJoinedEscrows(organizer.address)).to.be.empty; // Organizer didn't join, only created
            expect(details.leagueName).to.equal("Join Vault");
        });

        it("Should fail if token is zero address or dues are below minimum", async function () {
            const { dfsEscrowManager, mockToken, organizer } = await loadFixture(deployDFSEscrowManagerFixture);
            const minDues = await dfsEscrowManager.MINIMUM_DUES();
            const belowMin = minDues - 1n;
            const endTime = (await time.latest()) + (2 * 24 * 3600);
            await expect(
                dfsEscrowManager.connect(organizer).createEscrow(ethers.ZeroAddress, minDues, endTime, "N", 10)
            ).to.be.revertedWithCustomError(dfsEscrowManager, "InvalidToken");

            await expect(
                dfsEscrowManager.connect(organizer).createEscrow(await mockToken.getAddress(), belowMin, endTime, "N", 10)
            ).to.be.revertedWithCustomError(dfsEscrowManager, "InvalidDues");
        });

        it("Should fail if endTime is not at least 1 hour in the future", async function () {
            const { dfsEscrowManager, mockToken, organizer } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            const nearEndTime = (await time.latest()) + 1800; // Only 30 minutes from now

            await expect(
                dfsEscrowManager.connect(organizer).createEscrow(await mockToken.getAddress(), dues, nearEndTime, "T", 10)
            ).to.be.revertedWithCustomError(dfsEscrowManager, "EndTimeTooSoon");
        });

        it("Should reject empty league name", async function () {
            const { dfsEscrowManager, mockToken, organizer } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            const endTime = (await time.latest()) + (2 * 24 * 3600);

            await expect(
                dfsEscrowManager.connect(organizer).createEscrow(
                    await mockToken.getAddress(),
                    dues,
                    endTime,
                    "",
                    10
                )
            ).to.be.revertedWithCustomError(dfsEscrowManager, "EmptyLeagueName");
        });

        it("Should enforce MAX_PARTICIPANTS_CAP", async function () {
            const { dfsEscrowManager, mockToken, organizer } = await loadFixture(deployDFSEscrowManagerFixture);
            const cap = await dfsEscrowManager.MAX_PARTICIPANTS_CAP();
            const dues = ethers.parseUnits("1", 6);
            const endTime = (await time.latest()) + (2 * 24 * 3600);

            await expect(
                dfsEscrowManager.connect(organizer).createEscrow(
                    await mockToken.getAddress(),
                    dues,
                    endTime,
                    "CapTest",
                    cap + 1n
                )
            ).to.be.revertedWithCustomError(dfsEscrowManager, "InvalidMaxParticipants");
        });

        it("Should set sanitized symbol to FV when name has no alphanumerics", async function () {
            const { dfsEscrowManager, mockToken, organizer } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            const endTime = (await time.latest()) + (2 * 24 * 3600);

            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                endTime,
                "!!!",
                3
            );

            const details = await dfsEscrowManager.getEscrowDetails(0);
            const vault = await ethers.getContractAt("MockYearnVault", details.yearnVault) as MockYearnVault;
            expect(await vault.symbol()).to.equal("FV");
        });
    });
    
    describe("joinEscrow", function () {
        it("Should allow a participant to join with single entry and update tracking arrays", async function () {
            const { dfsEscrowManager, mockToken, organizer, participant1 } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            
            // Create escrow (organizer doesn't auto-join)
            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                (await time.latest()) + (2 * 24 * 3600),
                "Test Join",
                2
            );

            // Mint tokens to participant and approve manager
            await mockToken.mint(participant1.address, dues);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), dues);

            await expect(dfsEscrowManager.connect(participant1).joinEscrow(0, 1))
                .to.emit(dfsEscrowManager, "ParticipantJoined")
                .withArgs(0, participant1.address, 1);
            
            // Get the vault contract to check balances
            const details = await dfsEscrowManager.getEscrowDetails(0);
            const vault = await ethers.getContractAt("MockYearnVault", details.yearnVault);

            // Verify the underlying assets were transferred to the vault
            expect(await mockToken.balanceOf(details.yearnVault)).to.equal(dues);

            // Verify the DFSEscrowManager contract received the vault shares
            const managerAddress = await dfsEscrowManager.getAddress();
            expect(await vault.balanceOf(managerAddress)).to.equal(dues);
            expect(await vault.balanceOf(participant1.address)).to.equal(0);

            // Verify tracking arrays
            expect(await dfsEscrowManager.getJoinedEscrows(participant1.address)).to.deep.equal([0n]);
            expect(await dfsEscrowManager.getParticipants(0)).to.deep.equal([participant1.address]);
            
            // Verify entry counts
            expect(await dfsEscrowManager.userEntryCount(0, participant1.address)).to.equal(1);
            expect(await dfsEscrowManager.getTotalEntries(0)).to.equal(1);
        });

        it("Should allow a participant to join with multiple entries in one call", async function () {
            const { dfsEscrowManager, mockToken, organizer, participant1 } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            const numEntries = 5n;
            
            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                (await time.latest()) + (2 * 24 * 3600),
                "Multi Entry",
                100
            );

            const totalDues = dues * numEntries;
            await mockToken.mint(participant1.address, totalDues);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), totalDues);

            await expect(dfsEscrowManager.connect(participant1).joinEscrow(0, numEntries))
                .to.emit(dfsEscrowManager, "ParticipantJoined")
                .withArgs(0, participant1.address, numEntries);

            // Verify entry counts
            expect(await dfsEscrowManager.userEntryCount(0, participant1.address)).to.equal(numEntries);
            expect(await dfsEscrowManager.getTotalEntries(0)).to.equal(numEntries);
            
            // Verify vault balance
            const details = await dfsEscrowManager.getEscrowDetails(0);
            expect(await mockToken.balanceOf(details.yearnVault)).to.equal(totalDues);
        });

        it("Should allow a participant to add more entries in subsequent calls", async function () {
            const { dfsEscrowManager, mockToken, organizer, participant1 } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            
            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                (await time.latest()) + (2 * 24 * 3600),
                "Cumulative Entries",
                100
            );

            // First join with 3 entries
            await mockToken.mint(participant1.address, dues * 3n);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), dues * 3n);
            await dfsEscrowManager.connect(participant1).joinEscrow(0, 3);
            
            expect(await dfsEscrowManager.userEntryCount(0, participant1.address)).to.equal(3);
            expect(await dfsEscrowManager.getTotalEntries(0)).to.equal(3);

            // Add 2 more entries
            await mockToken.mint(participant1.address, dues * 2n);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), dues * 2n);
            await dfsEscrowManager.connect(participant1).joinEscrow(0, 2);
            
            // Verify cumulative entry counts
            expect(await dfsEscrowManager.userEntryCount(0, participant1.address)).to.equal(5);
            expect(await dfsEscrowManager.getTotalEntries(0)).to.equal(5);
            
            // Participant should only appear once in participantsList
            expect(await dfsEscrowManager.getParticipants(0)).to.deep.equal([participant1.address]);
        });

        it("Should revert if the pool is full (totalEntries >= maxParticipants)", async function () {
            const { dfsEscrowManager, mockToken, organizer, participant1, participant2 } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            const maxEntries = 5n;
            
            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                (await time.latest()) + (2 * 24 * 3600),
                "Full Pool",
                maxEntries
            );

            // P1 joins with maxEntries
            await mockToken.mint(participant1.address, dues * maxEntries);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), dues * maxEntries);
            await dfsEscrowManager.connect(participant1).joinEscrow(0, maxEntries);

            // P2 tries to join (should fail as totalEntries would exceed maxParticipants)
            await mockToken.mint(participant2.address, dues);
            await mockToken.connect(participant2).approve(await dfsEscrowManager.getAddress(), dues);
            await expect(dfsEscrowManager.connect(participant2).joinEscrow(0, 1))
                .to.be.revertedWithCustomError(dfsEscrowManager, "ExceedsMaxParticipants");
        });

        it("Should revert if user exceeds maxEntriesPerUser", async function () {
            const { dfsEscrowManager, mockToken, organizer, participant1 } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            const maxEntriesPerUser = await dfsEscrowManager.maxEntriesPerUser();
            
            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                (await time.latest()) + (2 * 24 * 3600),
                "Max Entries Test",
                10000
            );

            // Try to join with more than maxEntriesPerUser
            const tooManyEntries = maxEntriesPerUser + 1n;
            await mockToken.mint(participant1.address, dues * tooManyEntries);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), dues * tooManyEntries);
            
            await expect(dfsEscrowManager.connect(participant1).joinEscrow(0, tooManyEntries))
                .to.be.revertedWithCustomError(dfsEscrowManager, "ExceedsMaxEntriesPerUser");
        });

        it("Should revert if trying to join with zero entries", async function () {
            const { dfsEscrowManager, mockToken, organizer, participant1 } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            
            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                (await time.latest()) + (2 * 24 * 3600),
                "Zero Entries",
                10
            );

            await mockToken.mint(participant1.address, dues);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), dues);
            
            await expect(dfsEscrowManager.connect(participant1).joinEscrow(0, 0))
                .to.be.revertedWithCustomError(dfsEscrowManager, "InvalidAmount");
        });

        it("Should revert if trying to join after escrow end time", async function () {
            const { dfsEscrowManager, mockToken, organizer, participant1 } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            const endTimeSoon = (await time.latest()) + (2 * 24 * 3600); // ensure it passes createEscrow min duration check

            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                endTimeSoon,
                "LateJoin",
                2
            );

            await time.increaseTo(endTimeSoon + 1);
            await mockToken.mint(participant1.address, dues);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), dues);

            await expect(
                dfsEscrowManager.connect(participant1).joinEscrow(0, 1)
            ).to.be.revertedWithCustomError(dfsEscrowManager, "EscrowEnded");
        });
    });

    describe("addToPool", function () {
        it("Should allow a non-participant to add funds to the pool", async function () {
            const { dfsEscrowManager, mockToken, organizer, contributor } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            const contribution = ethers.parseUnits("50", 6);

            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(), 
                dues, 
                (await time.latest()) + (2 * 24 * 3600), 
                "Contrib", 
                5
            );
            
            await mockToken.mint(contributor.address, contribution);
            await mockToken.connect(contributor).approve(await dfsEscrowManager.getAddress(), contribution);

            await expect(dfsEscrowManager.connect(contributor).addToPool(0, contribution))
                .to.emit(dfsEscrowManager, "PoolFunded").withArgs(0, contributor.address, contribution);

            const details = await dfsEscrowManager.getEscrowDetails(0);
            const vault = await ethers.getContractAt("MockYearnVault", details.yearnVault);

            // Only contribution should be in vault (organizer didn't auto-join)
            expect(await mockToken.balanceOf(details.yearnVault)).to.equal(contribution);
            expect((await dfsEscrowManager.getParticipants(0)).length).to.equal(0); // No participants yet
        });

        it("Should revert if amount is zero", async function () {
            const { dfsEscrowManager, contributor } = await loadFixture(deployDFSEscrowManagerFixture);
            await expect(dfsEscrowManager.connect(contributor).addToPool(0, 0))
                .to.be.revertedWithCustomError(dfsEscrowManager, "InvalidAmount");
        });
    });

    describe("distributeWinnings", function () {
        // Helper fixture to set up a joined and ended escrow
        async function setupJoinedEscrow() {
            const { dfsEscrowManager, mockToken, organizer, participant1, participant2 } = await loadFixture(
                deployDFSEscrowManagerFixture
            );

            const dues = ethers.parseUnits("1", 6);
            const endTime = (await time.latest()) + (2 * 24 * 3600);

            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(), 
                dues, 
                endTime, 
                "TF", 
                10
            );

            await mockToken.mint(participant1.address, dues);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), dues);
            await dfsEscrowManager.connect(participant1).joinEscrow(0, 1);
            
            return { dfsEscrowManager, mockToken, organizer, participant1, participant2, dues, endTime };
        }

        it("Should allow the organizer to distribute the full amount and update active list", async function () {
            const { dfsEscrowManager, mockToken, organizer, participant1, participant2, dues, endTime } = await loadFixture(setupJoinedEscrow);

            // Create a second escrow to test removal logic
            const twoDaysFromNow = (await time.latest()) + (2 * 24 * 3600);
            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(), 
                dues, 
                twoDaysFromNow, 
                "Escrow2", 
                2
            );
            expect(await dfsEscrowManager.getActiveEscrowIds()).to.deep.equal([0n, 1n]);

            await time.increaseTo(endTime + 1);

            const totalPrize = dues; // Only participant1 joined
            const winners = [participant1.address];
            const amounts = [dues];

            const p1_initialBalance = await mockToken.balanceOf(participant1.address);

            // Test removal of the first element (escrowId 0)
            const tx = await dfsEscrowManager.connect(organizer).distributeWinnings(0, winners, amounts);
            const receipt = await tx.wait();
            const eventLog = receipt?.logs?.find(
                (log: any) => log.fragment && log.fragment.name === 'WinningsDistributed'
            ) as EventLog | undefined;
            expect(eventLog).to.not.be.undefined;
            if (!eventLog) throw new Error("WinningsDistributed event not found");
            expect(eventLog.args.escrowId).to.equal(0);
            expect(eventLog.args.winners).to.deep.equal(winners);
            expect(eventLog.args.amounts.map((a: any) => a)).to.deep.equal(amounts);

            expect(await mockToken.balanceOf(participant1.address)).to.equal(p1_initialBalance + dues);
            
            const details0 = await dfsEscrowManager.getEscrowDetails(0);
            expect(await mockToken.balanceOf(details0.yearnVault)).to.equal(0);
            
            const newDetails0 = await dfsEscrowManager.getEscrowDetails(0);
            expect(newDetails0.payoutsComplete).to.be.true;

            // Verify escrow 0 was removed and escrow 1 remains at index 0
            expect(await dfsEscrowManager.getActiveEscrowIds()).to.deep.equal([1n]);

            // Now, check that the index of the moved escrow (escrowId 1) was updated
            const escrow1Data = await dfsEscrowManager.escrows(1);
            expect(escrow1Data.activeArrayIndex).to.equal(0);
        });

        it("Should correctly distribute remainder to the last winner with slippage", async function () {
            const { dfsEscrowManager, mockToken, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);
            
            await time.increaseTo(endTime + 1);

            const details = await dfsEscrowManager.getEscrowDetails(0);
            const vault = await ethers.getContractAt("MockYearnVault", details.yearnVault);

            // Simulate 1% slippage on withdrawal (100 bps)
            await vault.set_slippage_bps(100);

            const totalInVault = dues; // Only participant1 joined
            const expectedWithdrawn = (totalInVault * 9900n) / 10000n;
            
            const winners = [participant1.address];
            const amounts = [dues];

            const p1_initial = await mockToken.balanceOf(participant1.address);

            await dfsEscrowManager.connect(organizer).distributeWinnings(0, winners, amounts);
            
            // Participant1 (the last winner) should receive the remainder accounting for slippage
            expect(await mockToken.balanceOf(participant1.address)).to.equal(p1_initial + expectedWithdrawn);
            
            const expectedDust = totalInVault - expectedWithdrawn;
            expect(await mockToken.balanceOf(details.yearnVault)).to.equal(expectedDust);
        });

        it("Should revert if total payout is outside tolerance", async function () {
            const { dfsEscrowManager, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);
            
            await time.increaseTo(endTime + 1);
            
            const totalInVault = dues;
            
            // Payout is too low (more than 3% below vault balance)
            const lowAmount = (totalInVault * 96n) / 100n;
            await expect(dfsEscrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [lowAmount]))
                .to.be.revertedWithCustomError(dfsEscrowManager, "PayoutExceedsTolerance");

            // Payout is too high (more than 3% above vault balance)
            const highAmount = (totalInVault * 104n) / 100n;
            await expect(dfsEscrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [highAmount]))
                .to.be.revertedWithCustomError(dfsEscrowManager, "PayoutExceedsTolerance");
        });

        it("Should revert if trying to close a funded pool with no winners", async function () {
            const { dfsEscrowManager, organizer, endTime } = await loadFixture(setupJoinedEscrow);

            await time.increaseTo(endTime + 1);

            // The pool has funds from participant1
            await expect(dfsEscrowManager.connect(organizer).distributeWinnings(0, [], []))
                .to.be.revertedWithCustomError(dfsEscrowManager, "CannotClosePoolWithFunds");
        });

        it("Should revert for invalid winner/amount arrays", async function () {
            const { dfsEscrowManager, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);
            
            await time.increaseTo(endTime + 1);
            
            // Mismatched lengths
            await expect(dfsEscrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [dues, dues]))
                .to.be.revertedWithCustomError(dfsEscrowManager, "PayoutArraysMismatch");

            // Duplicate winners
            await expect(dfsEscrowManager.connect(organizer).distributeWinnings(0, [participant1.address, participant1.address], [dues, dues]))
                .to.be.revertedWithCustomError(dfsEscrowManager, "NoDuplicateWinners");
        });

        it("Should revert if not called by organizer", async function () {
            const { dfsEscrowManager, participant1, endTime } = await loadFixture(setupJoinedEscrow);

            await time.increaseTo(endTime + 1);

            await expect(dfsEscrowManager.connect(participant1).distributeWinnings(0, [], []))
                .to.be.revertedWithCustomError(dfsEscrowManager, "NotOrganizer");
        });

        it("Should revert if winner is not a participant", async function () {
            const { dfsEscrowManager, organizer, participant2, dues, endTime } = await loadFixture(setupJoinedEscrow);

            await time.increaseTo(endTime + 1);
            await expect(
                dfsEscrowManager.connect(organizer).distributeWinnings(0, [participant2.address], [dues])
            ).to.be.revertedWithCustomError(dfsEscrowManager, "WinnerNotParticipant");
        });

        it("Should revert if too many recipients are provided", async function () {
            const { dfsEscrowManager, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);

            await time.increaseTo(endTime + 1);
            const winners = Array(101).fill(participant1.address); // MAX_RECIPIENTS is 100
            const amounts = Array(101).fill(1n);
            await expect(
                dfsEscrowManager.connect(organizer).distributeWinnings(0, winners, amounts)
            ).to.be.revertedWithCustomError(dfsEscrowManager, "TooManyRecipients");
        });

        it("Should revert if trying to distribute before escrow end", async function () {
            const { dfsEscrowManager, organizer, participant1, dues } = await loadFixture(setupJoinedEscrow);

            await expect(
                dfsEscrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [dues])
            ).to.be.revertedWithCustomError(dfsEscrowManager, "EscrowNotEnded");
        });

        it("Should not allow distributing winnings twice", async function () {
            const { dfsEscrowManager, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);

            await time.increaseTo(endTime + 1);
            await dfsEscrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [dues]);
            await expect(
                dfsEscrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [dues])
            ).to.be.revertedWithCustomError(dfsEscrowManager, "PayoutsAlreadyComplete");
        });
    });

    describe("setMaxEntriesPerUser", function () {
        it("Should allow owner to update maxEntriesPerUser", async function () {
            const { dfsEscrowManager, owner } = await loadFixture(deployDFSEscrowManagerFixture);
            
            expect(await dfsEscrowManager.maxEntriesPerUser()).to.equal(1000);
            
            await dfsEscrowManager.connect(owner).setMaxEntriesPerUser(500);
            expect(await dfsEscrowManager.maxEntriesPerUser()).to.equal(500);
            
            await expect(dfsEscrowManager.connect(owner).setMaxEntriesPerUser(500))
                .to.emit(dfsEscrowManager, "MaxEntriesPerUserUpdated")
                .withArgs(500);
        });

        it("Should revert if non-owner tries to update", async function () {
            const { dfsEscrowManager, organizer } = await loadFixture(deployDFSEscrowManagerFixture);
            
            await expect(
                dfsEscrowManager.connect(organizer).setMaxEntriesPerUser(500)
            ).to.be.revertedWithCustomError(dfsEscrowManager, "OwnableUnauthorizedAccount");
        });

        it("Should revert if trying to set to zero", async function () {
            const { dfsEscrowManager, owner } = await loadFixture(deployDFSEscrowManagerFixture);
            
            await expect(
                dfsEscrowManager.connect(owner).setMaxEntriesPerUser(0)
            ).to.be.revertedWithCustomError(dfsEscrowManager, "InvalidMaxEntries");
        });
    });

    describe("View Functions", function() {
        it("Should return correct data throughout the escrow lifecycle", async function() {
            const { dfsEscrowManager, mockToken, organizer, participant1, participant2 } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);

            // 1. Initial State
            expect(await dfsEscrowManager.getCreatedEscrows(organizer.address)).to.be.empty;
            expect(await dfsEscrowManager.getJoinedEscrows(organizer.address)).to.be.empty;
            expect(await dfsEscrowManager.getActiveEscrowIds()).to.be.empty;

            // 2. Create Escrow (organizer does NOT auto-join)
            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(), 
                dues, 
                (await time.latest()) + (2 * 24 * 3600), 
                "V", 
                3
            );

            expect(await dfsEscrowManager.getCreatedEscrows(organizer.address)).to.deep.equal([0n]);
            expect(await dfsEscrowManager.getJoinedEscrows(organizer.address)).to.be.empty; // Organizer didn't join
            expect(await dfsEscrowManager.getParticipants(0)).to.be.empty; // No participants yet
            expect(await dfsEscrowManager.getActiveEscrowIds()).to.deep.equal([0n]);
            const details = await dfsEscrowManager.getEscrowDetails(0);
            expect(details.leagueName).to.equal("V");

            // 3. P1 Joins with 2 entries
            await mockToken.mint(participant1.address, dues * 2n);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), dues * 2n);
            await dfsEscrowManager.connect(participant1).joinEscrow(0, 2);

            expect(await dfsEscrowManager.getJoinedEscrows(participant1.address)).to.deep.equal([0n]);
            expect(await dfsEscrowManager.getParticipants(0)).to.deep.equal([participant1.address]);
            expect(await dfsEscrowManager.getCreatedEscrows(participant1.address)).to.be.empty; // P1 didn't create it
            expect(await dfsEscrowManager.userEntryCount(0, participant1.address)).to.equal(2);
            expect(await dfsEscrowManager.getTotalEntries(0)).to.equal(2);
        });

        it("Should return correct user entry count", async function () {
            const { dfsEscrowManager, mockToken, organizer, participant1 } = await loadFixture(deployDFSEscrowManagerFixture);
            const dues = ethers.parseUnits("1", 6);
            
            await dfsEscrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                (await time.latest()) + (2 * 24 * 3600),
                "Entry Count Test",
                100
            );

            // User hasn't joined yet
            expect(await dfsEscrowManager.getUserEntryCount(0, participant1.address)).to.equal(0);

            // Join with 3 entries
            await mockToken.mint(participant1.address, dues * 3n);
            await mockToken.connect(participant1).approve(await dfsEscrowManager.getAddress(), dues * 3n);
            await dfsEscrowManager.connect(participant1).joinEscrow(0, 3);

            expect(await dfsEscrowManager.getUserEntryCount(0, participant1.address)).to.equal(3);
        });
    });
});
