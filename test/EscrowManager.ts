import { ethers } from "hardhat";
import { EventLog } from "ethers";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { EscrowManager, MockToken } from "../typechain-types";
import { MockYearnVault } from "../typechain-types/contracts/mocks/MockYearnVault";

// Main test suite for EscrowManager
describe("EscrowManager", function () {
    // Fixture to set up the initial state for each test
    async function deployEscrowManagerFixture() {
        const [owner, organizer, participant1, participant2, contributor] = await ethers.getSigners();

        const MockToken = await ethers.getContractFactory("MockToken");
        const mockToken = await MockToken.deploy();

        const MockVaultFactory = await ethers.getContractFactory("MockVaultFactory");
        const mockVaultFactory = await MockVaultFactory.deploy();
        const mockFactoryAddress = await mockVaultFactory.getAddress();

        const EscrowManager = await ethers.getContractFactory("EscrowManager");
        const escrowManager = await EscrowManager.deploy(mockFactoryAddress);

        return {
            escrowManager,
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
            const { escrowManager, mockVaultFactory } = await loadFixture(deployEscrowManagerFixture);
            const factoryAddress = await mockVaultFactory.getAddress();
            expect(await escrowManager.yearnVaultFactory()).to.equal(factoryAddress);
            expect(await escrowManager.nextEscrowId()).to.equal(0);
        });
    });

    describe("createEscrow", function () {
        it("Should create an escrow and correctly configure the new Yearn vault", async function () {
            const { escrowManager, mockToken, organizer } = await loadFixture(
                deployEscrowManagerFixture
            );

            const tokenAddress = await mockToken.getAddress();
            const dues = ethers.parseUnits("100", 18);
            const endTime = (await time.latest()) + (2 * 24 * 3600); // 2 days from now

            // Organizer must have funds and approval because they auto-join on creation
            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);

            const tx = await escrowManager.connect(organizer).createEscrow(tokenAddress, dues, endTime, "Test Vault", 10);
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

            // 1. Verify the EscrowManager set the correct role on the vault
            const escrowManagerAddress = await escrowManager.getAddress();
            expect(await mockVault.roles(escrowManagerAddress)).to.equal(256); // DEPOSIT_LIMIT_MANAGER role

            // 2. Verify the EscrowManager set the correct deposit limit on the vault
            expect(await mockVault.depositLimit()).to.equal(ethers.MaxUint256);

            // Check the details of the created escrow
            const details = await escrowManager.getEscrowDetails(0);
            expect(details.organizer).to.equal(organizer.address);
            expect(details.token).to.equal(tokenAddress);
            expect(details.dues).to.equal(dues);
            expect(details.leagueName).to.equal("Test Vault");

            // Check tracking arrays
            expect(await escrowManager.getCreatedEscrows(organizer.address)).to.deep.equal([0n]);
            expect(await escrowManager.getActiveEscrowIds()).to.deep.equal([0n]);
        });

        it("Organizer automatically joins upon creation", async function () {
            const { escrowManager, mockToken, organizer } = await loadFixture(deployEscrowManagerFixture);
            const dues = ethers.parseUnits("50", 18);
            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);

            await expect(
                escrowManager.connect(organizer).createEscrow(await mockToken.getAddress(), dues, (await time.latest()) + (2 * 24 * 3600), "Join Vault", 5)
            ).to.emit(escrowManager, "ParticipantJoined").withArgs(0, organizer.address);

            const details = await escrowManager.getEscrowDetails(0);
            const vault = await ethers.getContractAt("MockYearnVault", details.yearnVault);

            expect(await vault.balanceOf(await escrowManager.getAddress())).to.equal(dues);
            expect(await escrowManager.getJoinedEscrows(organizer.address)).to.deep.equal([0n]);
            expect(await escrowManager.getParticipants(0)).to.deep.equal([organizer.address]);
            expect(details.leagueName).to.equal("Join Vault");
        });

        it("Should fail if token is zero address or dues are below minimum", async function () {
            const { escrowManager, mockToken, organizer } = await loadFixture(deployEscrowManagerFixture);
            const minDues = await escrowManager.MINIMUM_DUES();
            const belowMin = minDues - 1n;
            const endTime = (await time.latest()) + (2 * 24 * 3600);
            await expect(
                escrowManager.connect(organizer).createEscrow(ethers.ZeroAddress, minDues, endTime, "N", 10)
            ).to.be.revertedWithCustomError(escrowManager, "InvalidToken");

            await expect(
                escrowManager.connect(organizer).createEscrow(await mockToken.getAddress(), belowMin, endTime, "N", 10)
            ).to.be.revertedWithCustomError(escrowManager, "InvalidDues");
        });

        it("Should fail if endTime is not at least 1 day in the future", async function () {
            const { escrowManager, mockToken, organizer } = await loadFixture(deployEscrowManagerFixture);
            const dues = ethers.parseUnits("100", 18);
            const nearEndTime = (await time.latest()) + 3600; // Only 1 hour from now

            await expect(
                escrowManager.connect(organizer).createEscrow(await mockToken.getAddress(), dues, nearEndTime, "T", 10)
            ).to.be.revertedWithCustomError(escrowManager, "EndTimeTooSoon");
        });

        it("Should reject empty league name", async function () {
            const { escrowManager, mockToken, organizer } = await loadFixture(deployEscrowManagerFixture);
            const dues = ethers.parseUnits("100", 18);
            const endTime = (await time.latest()) + (2 * 24 * 3600);

            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);

            await expect(
                escrowManager.connect(organizer).createEscrow(
                    await mockToken.getAddress(),
                    dues,
                    endTime,
                    "",
                    10
                )
            ).to.be.revertedWithCustomError(escrowManager, "EmptyLeagueName");
        });

        it("Should enforce MAX_PARTICIPANTS_CAP", async function () {
            const { escrowManager, mockToken, organizer } = await loadFixture(deployEscrowManagerFixture);
            const cap = await escrowManager.MAX_PARTICIPANTS_CAP();
            const dues = ethers.parseUnits("100", 18);
            const endTime = (await time.latest()) + (2 * 24 * 3600);

            // No need to mint/approve since the call should revert before deposit
            await expect(
                escrowManager.connect(organizer).createEscrow(
                    await mockToken.getAddress(),
                    dues,
                    endTime,
                    "CapTest",
                    cap + 1n
                )
            ).to.be.revertedWithCustomError(escrowManager, "InvalidMaxParticipants");
        });

        it("Should set sanitized symbol to FV when name has no alphanumerics", async function () {
            const { escrowManager, mockToken, organizer } = await loadFixture(deployEscrowManagerFixture);
            const dues = ethers.parseUnits("10", 18);
            const endTime = (await time.latest()) + (2 * 24 * 3600);

            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);

            await escrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                endTime,
                "!!!",
                3
            );

            const details = await escrowManager.getEscrowDetails(0);
            const vault = await ethers.getContractAt("MockYearnVault", details.yearnVault) as MockYearnVault;
            expect(await vault.symbol()).to.equal("FV");
        });
    });
    
    describe("joinEscrow", function () {
        it("Should allow a participant to join and update tracking arrays", async function () {
            const { escrowManager, mockToken, organizer, participant1 } = await loadFixture(deployEscrowManagerFixture);
            const dues = ethers.parseUnits("100", 18);
            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                (await time.latest()) + (2 * 24 * 3600),
                "Test Join",
                2
            );

            // Mint tokens to participant and approve manager
            await mockToken.mint(participant1.address, dues);
            await mockToken.connect(participant1).approve(await escrowManager.getAddress(), dues);

            await expect(escrowManager.connect(participant1).joinEscrow(0)).to.emit(
                escrowManager,
                "ParticipantJoined"
            ).withArgs(0, participant1.address);
            
            // Get the vault contract to check balances
            const details = await escrowManager.getEscrowDetails(0);
            const vault = await ethers.getContractAt("MockYearnVault", details.yearnVault);

            // Verify the underlying assets were transferred to the vault (organizer + participant)
            expect(await mockToken.balanceOf(details.yearnVault)).to.equal(dues * 2n);

            // CRITICAL: Verify the EscrowManager contract (not the user) received the vault shares (for both deposits)
            const managerAddress = await escrowManager.getAddress();
            expect(await vault.balanceOf(managerAddress)).to.equal(dues * 2n);
            expect(await vault.balanceOf(participant1.address)).to.equal(0);

            // Verify tracking arrays
            expect(await escrowManager.getJoinedEscrows(participant1.address)).to.deep.equal([0n]);
            expect(await escrowManager.getParticipants(0)).to.deep.equal([organizer.address, participant1.address]);
        });

        it("Should revert if the pool is full", async function () {
            const { escrowManager, mockToken, organizer, participant1, participant2 } = await loadFixture(deployEscrowManagerFixture);
            const dues = ethers.parseUnits("100", 18);
            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                (await time.latest()) + (2 * 24 * 3600),
                "Test Join",
                2 // maxParticipants set to 2
            );

            // P1 joins
            await mockToken.mint(participant1.address, dues);
            await mockToken.connect(participant1).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(participant1).joinEscrow(0);

            // P2 tries to join (should fail as max is 2)
            await mockToken.mint(participant2.address, dues);
            await mockToken.connect(participant2).approve(await escrowManager.getAddress(), dues);
            await expect(escrowManager.connect(participant2).joinEscrow(0)).to.be.revertedWithCustomError(escrowManager, "PoolFull");
        });

        it("Should revert if participant tries to join twice", async function () {
            const { escrowManager, mockToken, organizer, participant1 } = await loadFixture(deployEscrowManagerFixture);
            const dues = ethers.parseUnits("100", 18);
            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                (await time.latest()) + (2 * 24 * 3600),
                "Test Join",
                2
            );
            
            await mockToken.mint(participant1.address, dues);
            await mockToken.connect(participant1).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(participant1).joinEscrow(0); // First join is successful

            // Trying to join again should fail
            await expect(
                escrowManager.connect(participant1).joinEscrow(0)
            ).to.be.revertedWithCustomError(escrowManager, "AlreadyParticipating");
        });

        it("Should revert if trying to join after escrow end time", async function () {
            const { escrowManager, mockToken, organizer, participant1 } = await loadFixture(deployEscrowManagerFixture);
            const dues = ethers.parseUnits("10", 18);
            const endTimeSoon = (await time.latest()) + (2 * 24 * 3600); // ensure it passes createEscrow min duration check

            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(organizer).createEscrow(
                await mockToken.getAddress(),
                dues,
                endTimeSoon,
                "LateJoin",
                2
            );

            await time.increaseTo(endTimeSoon + 1);
            await mockToken.mint(participant1.address, dues);
            await mockToken.connect(participant1).approve(await escrowManager.getAddress(), dues);

            await expect(
                escrowManager.connect(participant1).joinEscrow(0)
            ).to.be.revertedWithCustomError(escrowManager, "EscrowEnded");
        });
    });

    describe("addToPool", function () {
        it("Should allow a non-participant to add funds to the pool", async function () {
            const { escrowManager, mockToken, organizer, contributor } = await loadFixture(deployEscrowManagerFixture);
            const dues = ethers.parseUnits("100", 18);
            const contribution = ethers.parseUnits("50", 18);

            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(organizer).createEscrow(await mockToken.getAddress(), dues, (await time.latest()) + (2 * 24 * 3600), "Contrib", 5);
            
            await mockToken.mint(contributor.address, contribution);
            await mockToken.connect(contributor).approve(await escrowManager.getAddress(), contribution);

            await expect(escrowManager.connect(contributor).addToPool(0, contribution))
                .to.emit(escrowManager, "PoolFunded").withArgs(0, contributor.address, contribution);

            const details = await escrowManager.getEscrowDetails(0);
            const vault = await ethers.getContractAt("MockYearnVault", details.yearnVault);

            // Organizer's dues are already in the vault; plus contribution
            expect(await mockToken.balanceOf(details.yearnVault)).to.equal(dues + contribution);
            expect((await escrowManager.getParticipants(0)).length).to.equal(1); // Organizer auto-joined
        });

        it("Should revert if amount is zero", async function () {
            const { escrowManager, contributor } = await loadFixture(deployEscrowManagerFixture);
            await expect(escrowManager.connect(contributor).addToPool(0, 0))
                .to.be.revertedWithCustomError(escrowManager, "InvalidAmount");
        });
    });

    describe("distributeWinnings", function () {
        // Helper fixture to set up a joined and ended escrow
        async function setupJoinedEscrow() {
            const { escrowManager, mockToken, organizer, participant1, participant2 } = await loadFixture(
                deployEscrowManagerFixture
            );

            const dues = ethers.parseUnits("100", 18);
            const endTime = (await time.latest()) + (2 * 24 * 3600);

            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(organizer).createEscrow(await mockToken.getAddress(), dues, endTime, "TF", 10);

            await mockToken.mint(participant1.address, dues);
            await mockToken.connect(participant1).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(participant1).joinEscrow(0);
            
            return { escrowManager, mockToken, organizer, participant1, participant2, dues, endTime };
        }

        it("Should allow the organizer to distribute the full amount and update active list", async function () {
            const { escrowManager, mockToken, organizer, participant1, participant2, dues, endTime } = await loadFixture(setupJoinedEscrow);

            // Create a second escrow to test removal logic
            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);
            const twoDaysFromNow = (await time.latest()) + (2 * 24 * 3600);
            await escrowManager.connect(organizer).createEscrow(await mockToken.getAddress(), dues, twoDaysFromNow, "Escrow2", 2);
            expect(await escrowManager.getActiveEscrowIds()).to.deep.equal([0n, 1n]);

            await time.increaseTo(endTime + 1);

            const totalPrize = dues * 2n; // organizer + participant1
            const winners = [participant1.address, organizer.address];
            const amounts = [dues, dues];

            const p1_initialBalance = await mockToken.balanceOf(participant1.address);

            // Test removal of the first element (escrowId 0)
            const tx = await escrowManager.connect(organizer).distributeWinnings(0, winners, amounts);
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
            
            const details0 = await escrowManager.getEscrowDetails(0);
            expect(await mockToken.balanceOf(details0.yearnVault)).to.equal(0);
            
            const newDetails0 = await escrowManager.getEscrowDetails(0);
            expect(newDetails0.payoutsComplete).to.be.true;

            // Verify escrow 0 was removed and escrow 1 remains at index 0
            expect(await escrowManager.getActiveEscrowIds()).to.deep.equal([1n]);

            // Now, check that the index of the moved escrow (escrowId 1) was updated
            const escrow1Data = await escrowManager.escrows(1);
            expect(escrow1Data.activeArrayIndex).to.equal(0);
        });

        it("Should correctly distribute remainder to the last winner with slippage", async function () {
            const { escrowManager, mockToken, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);
            
            await time.increaseTo(endTime + 1);

            const details = await escrowManager.getEscrowDetails(0);
            const vault = await ethers.getContractAt("MockYearnVault", details.yearnVault);

            // Simulate 1% slippage on withdrawal (100 bps)
            await vault.set_slippage_bps(100);

            const totalInVault = dues * 2n; // 200
            const expectedWithdrawn = (totalInVault * 9900n) / 10000n; // 198
            
            const winners = [organizer.address, participant1.address];
            // Organizer intends to pay 100 to self, and 100 to P1
            const amounts = [dues, dues];

            const org_initial = await mockToken.balanceOf(organizer.address);
            const p1_initial = await mockToken.balanceOf(participant1.address);

            await escrowManager.connect(organizer).distributeWinnings(0, winners, amounts);
            
            // Organizer should have received their intended `dues`
            expect(await mockToken.balanceOf(organizer.address)).to.equal(org_initial + dues);
            
            // Participant1 (the last winner) should receive the remainder
            const expectedRemainder = expectedWithdrawn - dues;
            expect(await mockToken.balanceOf(participant1.address)).to.equal(p1_initial + expectedRemainder);
            
            const expectedDust = totalInVault - expectedWithdrawn;
            expect(await mockToken.balanceOf(details.yearnVault)).to.equal(expectedDust);
        });

        it("Should revert if total payout is outside tolerance", async function () {
            const { escrowManager, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);
            
            await time.increaseTo(endTime + 1);
            
            const totalInVault = dues * 2n; // 200
            
            // Payout is too low (more than 3% below vault balance)
            const lowAmount = (totalInVault * 96n) / 100n; // 192 (4% less)
            await expect(escrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [lowAmount]))
                .to.be.revertedWithCustomError(escrowManager, "PayoutExceedsTolerance");

            // Payout is too high (more than 3% above vault balance)
            const highAmount = (totalInVault * 104n) / 100n; // 208 (4% more)
            await expect(escrowManager.connect(organizer).distributeWinnings(0, [participant1.address, organizer.address], [dues, highAmount - dues]))
                .to.be.revertedWithCustomError(escrowManager, "PayoutExceedsTolerance");
        });

        it("Should revert if trying to close a funded pool with no winners", async function () {
            const { escrowManager, organizer, endTime } = await loadFixture(setupJoinedEscrow);

            await time.increaseTo(endTime + 1);

            // The pool has funds from the organizer and participant1
            await expect(escrowManager.connect(organizer).distributeWinnings(0, [], []))
                .to.be.revertedWithCustomError(escrowManager, "CannotClosePoolWithFunds");
        });

        it("Should revert if payout amount doesn't match vault balance", async function () {
            const { escrowManager, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);
            
            await time.increaseTo(endTime + 1);
            
            // Amount is too small (pot is 200, trying to send 100)
            await expect(escrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [dues]))
                .to.be.revertedWithCustomError(escrowManager, "PayoutExceedsTolerance");
        });

        it("Should revert for invalid winner/amount arrays", async function () {
            const { escrowManager, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);
            
            await time.increaseTo(endTime + 1);
            
            // Mismatched lengths
            await expect(escrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [dues, dues]))
                .to.be.revertedWithCustomError(escrowManager, "PayoutArraysMismatch");

            // Duplicate winners
            await expect(escrowManager.connect(organizer).distributeWinnings(0, [participant1.address, participant1.address], [dues, dues]))
                .to.be.revertedWithCustomError(escrowManager, "NoDuplicateWinners");
        });

        it("Should revert if not called by organizer", async function () {
            const { escrowManager, participant1, endTime } = await loadFixture(setupJoinedEscrow);

            await time.increaseTo(endTime + 1);

            await expect(escrowManager.connect(participant1).distributeWinnings(0, [], []))
                .to.be.revertedWithCustomError(escrowManager, "NotOrganizer");
        });

        it("Should revert if winner is not a participant", async function () {
            const { escrowManager, organizer, participant2, dues, endTime } = await loadFixture(setupJoinedEscrow);

            await time.increaseTo(endTime + 1);
            await expect(
                escrowManager.connect(organizer).distributeWinnings(0, [participant2.address], [dues])
            ).to.be.revertedWithCustomError(escrowManager, "WinnerNotParticipant");
        });

        it("Should revert if too many recipients are provided", async function () {
            const { escrowManager, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);

            await time.increaseTo(endTime + 1);
            const winners = Array(31).fill(participant1.address);
            const amounts = Array(31).fill(1n);
            await expect(
                escrowManager.connect(organizer).distributeWinnings(0, winners, amounts)
            ).to.be.revertedWithCustomError(escrowManager, "TooManyRecipients");
        });

        it("Should revert if trying to distribute before escrow end", async function () {
            const { escrowManager, organizer, participant1, dues } = await loadFixture(setupJoinedEscrow);

            await expect(
                escrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [dues])
            ).to.be.revertedWithCustomError(escrowManager, "EscrowNotEnded");
        });

        it("Should not allow distributing winnings twice", async function () {
            const { escrowManager, organizer, participant1, dues, endTime } = await loadFixture(setupJoinedEscrow);

            await time.increaseTo(endTime + 1);
            await escrowManager.connect(organizer).distributeWinnings(0, [participant1.address, organizer.address], [dues, dues]);
            await expect(
                escrowManager.connect(organizer).distributeWinnings(0, [participant1.address], [dues])
            ).to.be.revertedWithCustomError(escrowManager, "PayoutsAlreadyComplete");
        });
    });

    describe("View Functions", function() {
        it("Should return correct data throughout the escrow lifecycle", async function() {
            const { escrowManager, mockToken, organizer, participant1, participant2 } = await loadFixture(deployEscrowManagerFixture);
            const dues = ethers.parseUnits("10", 18);

            // 1. Initial State
            expect(await escrowManager.getCreatedEscrows(organizer.address)).to.be.empty;
            expect(await escrowManager.getJoinedEscrows(organizer.address)).to.be.empty;
            expect(await escrowManager.getActiveEscrowIds()).to.be.empty;

            // 2. Create Escrow
            await mockToken.mint(organizer.address, dues);
            await mockToken.connect(organizer).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(organizer).createEscrow(await mockToken.getAddress(), dues, (await time.latest()) + (2 * 24 * 3600), "V", 3); // Organizer auto-joins

            expect(await escrowManager.getCreatedEscrows(organizer.address)).to.deep.equal([0n]);
            expect(await escrowManager.getJoinedEscrows(organizer.address)).to.deep.equal([0n]);
            expect(await escrowManager.getParticipants(0)).to.deep.equal([organizer.address]);
            expect(await escrowManager.getActiveEscrowIds()).to.deep.equal([0n]);
            const details = await escrowManager.getEscrowDetails(0);
            expect(details.leagueName).to.equal("V");

            // 3. P1 Joins
            await mockToken.mint(participant1.address, dues);
            await mockToken.connect(participant1).approve(await escrowManager.getAddress(), dues);
            await escrowManager.connect(participant1).joinEscrow(0);

            expect(await escrowManager.getJoinedEscrows(participant1.address)).to.deep.equal([0n]);
            expect(await escrowManager.getParticipants(0)).to.deep.equal([organizer.address, participant1.address]);
            expect(await escrowManager.getCreatedEscrows(participant1.address)).to.be.empty; // P1 didn't create it
        });
    });
});