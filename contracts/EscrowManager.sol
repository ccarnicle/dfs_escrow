// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVaultFactory} from "./interfaces/IVaultFactory.sol";
import {IYearnVault} from "./interfaces/IYearnVault.sol";

/**
 * @title EscrowManager
 * @author aiSports
 * @notice This contract manages the creation, participation, and payout of fantasy sports prize pools.
 * It integrates with Yearn V3 Vaults for secure fund custody, where each escrow gets its own dedicated vault.
 * The contract itself does not hold user funds for escrows; it acts as a role manager for the Yearn vaults.
 * @dev The trust model assumes the organizer is responsible for triggering payouts correctly.
 * This contract is designed for standard ERC20 tokens and does not support fee-on-transfer or rebasing tokens.
 */
contract EscrowManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Constants ---
    uint256 public constant MAX_RECIPIENTS = 30; //this is a safeguard to prevent lockup of funds in the escrow. We may need to increase this in the future (or implement a more sophisticated mechanism).
    uint256 public constant MINIMUM_DUES = 1 * 1e18; //only works with tokens that have 18 decimals
    uint256 public constant MAX_LEAGUE_NAME_LENGTH = 50; //max length of the league name to prevent overflows
    uint256 public constant MINIMUM_ESCROW_DURATION = 1 days; //minimum duration of an escrow, to prevent abuse
    uint256 public constant MAX_PARTICIPANTS_CAP = 10_000; // upper bound to keep on-chain arrays bounded

    // --- State Variables ---
    address public immutable yearnVaultFactory;
    uint256 public nextEscrowId;

    // User-centric tracking
    mapping(address => uint256[]) public createdEscrows;
    mapping(address => uint256[]) public joinedEscrows;
    uint256[] public activeEscrowIds;

    struct Escrow {
        address organizer;
        IYearnVault yearnVault;
        IERC20 token;
        uint256 dues;
        uint256 endTime;
        mapping(address => bool) participants;
        bool payoutsComplete;
        uint256 maxParticipants;
        address[] participantsList;
        uint256 activeArrayIndex;
        string leagueName;
    }

    mapping(uint256 => Escrow) public escrows;

    // --- Events ---
    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed organizer,
        address yearnVault,
        address indexed token,
        uint256 dues,
        uint256 endTime
    );

    event ParticipantJoined(uint256 indexed escrowId, address indexed participant);

    event WinningsDistributed(uint256 indexed escrowId, address[] winners, uint256[] amounts);

    event PoolFunded(uint256 indexed escrowId, address indexed contributor, uint256 amount);

    // --- Errors ---
    error InvalidToken();
    error InvalidDues();
    error EscrowEnded();
    error AlreadyParticipating();
    error NotOrganizer();
    error EscrowNotEnded();
    error PayoutsAlreadyComplete();
    error TooManyRecipients();
    error NoDuplicateWinners();
    error PayoutArraysMismatch();
    error PoolFull();
    error InvalidAmount();
    error LeagueNameTooLong();
    error EndTimeTooSoon();
    error InvalidMaxParticipants();
    error PayoutExceedsTolerance(uint256 totalPayout, uint256 maxWithdrawable);
    error CannotClosePoolWithFunds();
    error EmptyLeagueName();
    error WinnerNotParticipant();

    // --- Constructor ---
    constructor(address _yearnVaultFactory) {
        yearnVaultFactory = _yearnVaultFactory;
    }

    // --- External Functions ---

    /**
     * @notice Creates a new prize pool (escrow).
     * @dev Deploys a new Yearn V3 Vault to hold the funds for this escrow.
     * @param _token The ERC20 token for the prize pool.
     * @param _dues The amount required to join.
     * @param _endTime The timestamp when the escrow closes for new participants.
     * @param _vaultName The name for the new Yearn Vault.
     * @param _maxParticipants The maximum number of participants allowed.
     */
    function createEscrow(
        address _token,
        uint256 _dues,
        uint256 _endTime,
        string calldata _vaultName,
        uint256 _maxParticipants
    ) external nonReentrant {
        if (_token == address(0)) revert InvalidToken();
        if (_dues < MINIMUM_DUES) revert InvalidDues();
        if (bytes(_vaultName).length == 0) revert EmptyLeagueName();
        if (bytes(_vaultName).length > MAX_LEAGUE_NAME_LENGTH) revert LeagueNameTooLong();
        if (_endTime < block.timestamp + MINIMUM_ESCROW_DURATION) revert EndTimeTooSoon();
        if (_maxParticipants == 0 || _maxParticipants > MAX_PARTICIPANTS_CAP) revert InvalidMaxParticipants();

        uint256 escrowId = nextEscrowId;

        // Deploy a new Yearn vault for this escrow.
        // The EscrowManager will be the role_manager, giving it control over the vault.
        // For simplicity, the vault symbol is derived from its name.
        // Sanitize a symbol from the provided name: uppercase A-Z0-9 only, max 11 chars
        string memory sanitizedSymbol = _sanitizeSymbol(_vaultName);

        address newVaultAddress = IVaultFactory(yearnVaultFactory).deploy_new_vault(
            _token,
            _vaultName,
            sanitizedSymbol,
            address(this), // role_manager
            0 // profit_max_unlock_time
        );

        // --- Configure the new vault ---
        IYearnVault newVault = IYearnVault(newVaultAddress);

        // As the role_manager, the EscrowManager gives itself the DEPOSIT_LIMIT_MANAGER role.
        // The role enum is: DEPOSIT_LIMIT_MANAGER = 2**8 = 256
        newVault.set_role(address(this), 256);

        // With the new role, it sets the deposit limit to be effectively infinite.
        newVault.set_deposit_limit(type(uint256).max, true);

        // Store the new escrow's data.
        Escrow storage newEscrow = escrows[escrowId];
        newEscrow.organizer = msg.sender;
        newEscrow.yearnVault = newVault;
        newEscrow.token = IERC20(_token);
        newEscrow.dues = _dues;
        newEscrow.endTime = _endTime;
        newEscrow.maxParticipants = _maxParticipants;
        newEscrow.leagueName = _vaultName;

        // Track the created escrow
        createdEscrows[msg.sender].push(escrowId);
        newEscrow.activeArrayIndex = activeEscrowIds.length;
        activeEscrowIds.push(escrowId);

        nextEscrowId++;

        emit EscrowCreated(
            escrowId,
            msg.sender,
            newVaultAddress,
            _token,
            _dues,
            _endTime
        );

        // Organizer automatically joins upon creation
        newEscrow.participants[msg.sender] = true;
        newEscrow.participantsList.push(msg.sender);
        joinedEscrows[msg.sender].push(escrowId);

        // Transfer dues to this contract, approve the vault, and deposit.
        newEscrow.token.safeTransferFrom(
            msg.sender,
            address(this),
            newEscrow.dues
        );
        newEscrow.token.forceApprove(address(newEscrow.yearnVault), 0);
        newEscrow.token.forceApprove(address(newEscrow.yearnVault), newEscrow.dues);
        newEscrow.yearnVault.deposit(newEscrow.dues, address(this));

        emit ParticipantJoined(escrowId, msg.sender);
    }

    // --- Internal Helpers ---
    function _sanitizeSymbol(string memory name) internal pure returns (string memory) {
        bytes memory src = bytes(name);
        uint256 maxLen = 11;
        bytes memory tmp = new bytes(maxLen);
        uint256 len = 0;
        for (uint256 i = 0; i < src.length && len < maxLen; i++) {
            uint8 c = uint8(src[i]);
            // convert lowercase to uppercase
            if (c >= 97 && c <= 122) {
                c = c - 32;
            }
            bool isAlpha = (c >= 65 && c <= 90); // A-Z
            bool isDigit = (c >= 48 && c <= 57); // 0-9
            if (isAlpha || isDigit) {
                tmp[len] = bytes1(c);
                len++;
            }
        }
        if (len == 0) {
            return "FV";
        }
        bytes memory out = new bytes(len);
        for (uint256 j = 0; j < len; j++) {
            out[j] = tmp[j];
        }
        return string(out);
    }

    /**
     * @notice Joins an existing prize pool.
     * @dev Transfers `dues` from the caller directly into the escrow's Yearn Vault.
     * @param _escrowId The ID of the escrow to join.
     */
    function joinEscrow(uint256 _escrowId) external nonReentrant {
        Escrow storage escrow = escrows[_escrowId];

        if (block.timestamp > escrow.endTime) revert EscrowEnded();
        if (escrow.participants[msg.sender]) revert AlreadyParticipating();
        if (escrow.participantsList.length >= escrow.maxParticipants) revert PoolFull();

        escrow.participants[msg.sender] = true;
        escrow.participantsList.push(msg.sender);
        joinedEscrows[msg.sender].push(_escrowId);

        // The user must have approved this contract to spend their tokens.
        // First, transfer the funds from the user to this EscrowManager contract.
        escrow.token.safeTransferFrom(msg.sender, address(this), escrow.dues);
        
        // Then, approve the Yearn vault to pull the funds from this contract.
        escrow.token.forceApprove(address(escrow.yearnVault), 0);
        escrow.token.forceApprove(address(escrow.yearnVault), escrow.dues);

        // Finally, deposit the funds into the Yearn vault.
        // The EscrowManager contract receives the shares, acting as custodian for the participants.
        escrow.yearnVault.deposit(escrow.dues, address(this));

        emit ParticipantJoined(_escrowId, msg.sender);
    }

    /**
     * @notice Allows anyone to add funds to an escrow pool without becoming a participant.
     * @dev This is useful for prize top-ups or community contributions.
     * @param _escrowId The ID of the escrow to fund.
     * @param _amount The amount of tokens to add.
     */
    function addToPool(uint256 _escrowId, uint256 _amount) external nonReentrant {
        if (_amount == 0) revert InvalidAmount();

        Escrow storage escrow = escrows[_escrowId];

        // Transfer funds from the sender to this contract
        escrow.token.safeTransferFrom(msg.sender, address(this), _amount);

        // Approve the vault to spend the tokens
        escrow.token.forceApprove(address(escrow.yearnVault), 0);
        escrow.token.forceApprove(address(escrow.yearnVault), _amount);

        // Deposit into the Yearn vault
        escrow.yearnVault.deposit(_amount, address(this));

        emit PoolFunded(_escrowId, msg.sender, _amount);
    }

    /**
     * @notice Distributes the winnings to the specified winners.
     * @dev Can only be called by the organizer after the escrow has ended.
     * Withdraws the total required amount from the Yearn Vault and distributes it.
     * @param _escrowId The ID of the escrow to distribute.
     * @param _winners An array of winner addresses.
     * @param _amounts An array of amounts corresponding to each winner.
     */
    function distributeWinnings(
        uint256 _escrowId,
        address[] calldata _winners,
        uint256[] calldata _amounts
    ) external nonReentrant {
        Escrow storage escrow = escrows[_escrowId];

        if (msg.sender != escrow.organizer) revert NotOrganizer();
        if (block.timestamp < escrow.endTime) revert EscrowNotEnded();
        if (escrow.payoutsComplete) revert PayoutsAlreadyComplete();
        if (_winners.length > MAX_RECIPIENTS) revert TooManyRecipients();
        if (_winners.length != _amounts.length) revert PayoutArraysMismatch();
        if (_winners.length == 0) {
            // Prevent closing out the escrow if there are still funds in the vault.
            if (escrow.yearnVault.totalAssets() > 0) {
                revert CannotClosePoolWithFunds();
            }
            // If there are no funds and no winners, it's safe to close.
            escrow.payoutsComplete = true;
            emit WinningsDistributed(_escrowId, _winners, _amounts);
            return;
        }


        // Use a memory array to track paid addresses to prevent duplicates in a single call.
        address[] memory paidAddresses = new address[](_winners.length);
        uint256 totalPayout;
        for (uint256 i = 0; i < _winners.length; i++) {
            address winner = _winners[i];
            // Ensure each winner is a participant in the escrow
            if (!escrow.participants[winner]) {
                revert WinnerNotParticipant();
            }
            // Check for duplicates
            for (uint256 j = 0; j < i; j++) {
                if (paidAddresses[j] == winner) {
                    revert NoDuplicateWinners();
                }
            }
            paidAddresses[i] = winner;
            totalPayout += _amounts[i];
        }

        uint256 maxWithdrawable = escrow.yearnVault.maxWithdraw(address(this));

        // Check if totalPayout is within 3% tolerance of maxWithdrawable
        // to protect against mismatched payout arrays and allow for minor slippage.
        uint256 lowerBound = (maxWithdrawable * 97) / 100;
        uint256 upperBound = (maxWithdrawable * 103) / 100;

        if (totalPayout < lowerBound || totalPayout > upperBound) {
            revert PayoutExceedsTolerance(totalPayout, maxWithdrawable);
        }

        // --- EFFECTS (CEI) ---
        // Mark payouts as complete
        escrow.payoutsComplete = true;

        // O(1) removal from the active list
        uint256 indexToRemove = escrow.activeArrayIndex;
        uint256 lastEscrowId = activeEscrowIds[activeEscrowIds.length - 1];
        // Move the last element to the place of the one to be removed
        activeEscrowIds[indexToRemove] = lastEscrowId;
        // Update the index of the element that was moved
        escrows[lastEscrowId].activeArrayIndex = indexToRemove;
        // Remove the last element, which is now a duplicate
        activeEscrowIds.pop();

        // Emit the distribution event before external calls (will revert if any interaction fails)
        emit WinningsDistributed(_escrowId, _winners, _amounts);

        // --- INTERACTIONS ---
        if (maxWithdrawable > 0) {
            uint256 balanceBefore = escrow.token.balanceOf(address(this));
            escrow.yearnVault.withdraw(maxWithdrawable, address(this), address(this));
            uint256 withdrawnAmount = escrow.token.balanceOf(address(this)) - balanceBefore;

            uint256 distributedSoFar = 0;
            // Distribute to all but the last winner
            if (_winners.length > 1) {
                for (uint256 i = 0; i < _winners.length - 1; i++) {
                    uint256 amount = _amounts[i];
                    if (amount > 0) {
                        escrow.token.safeTransfer(_winners[i], amount);
                        distributedSoFar += amount;
                    }
                }
            }
            
            // The last winner gets the remainder of the withdrawn amount.
            // This ensures the contract balance is cleared and accounts for any vault slippage.
            if (withdrawnAmount > distributedSoFar) {
                uint256 remainder = withdrawnAmount - distributedSoFar;
                escrow.token.safeTransfer(_winners[_winners.length - 1], remainder);
            }
        }
    }

    // --- View Functions ---

    /**
     * @notice Returns the list of participants for a given escrow.
     * @param _escrowId The ID of the escrow.
     * @return An array of participant addresses.
     */
    function getParticipants(uint256 _escrowId) external view returns (address[] memory) {
        return escrows[_escrowId].participantsList;
    }

    /**
     * @notice Returns the list of escrow IDs created by a user.
     * @param _user The address of the user.
     * @return An array of escrow IDs.
     */
    function getCreatedEscrows(address _user) external view returns (uint256[] memory) {
        uint256[] storage ids = createdEscrows[_user];
        uint256[] memory memoryIds = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            memoryIds[i] = ids[i];
        }
        return memoryIds;
    }

    /**
     * @notice Returns the list of escrow IDs a user has joined.
     * @param _user The address of the user.
     * @return An array of escrow IDs.
     */
    function getJoinedEscrows(address _user) external view returns (uint256[] memory) {
        uint256[] storage ids = joinedEscrows[_user];
        uint256[] memory memoryIds = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            memoryIds[i] = ids[i];
        }
        return memoryIds;
    }

    /**
     * @notice Returns the list of all active (non-completed) escrow IDs.
     * @return An array of active escrow IDs.
     */
    function getActiveEscrowIds() external view returns (uint256[] memory) {
        uint256[] memory memoryIds = new uint256[](activeEscrowIds.length);
        for (uint256 i = 0; i < activeEscrowIds.length; i++) {
            memoryIds[i] = activeEscrowIds[i];
        }
        return memoryIds;
    }

    /**
     * @notice Returns the core details of a specific escrow pool.
     * @param _escrowId The ID of the escrow to query.
     */
    function getEscrowDetails(uint256 _escrowId)
        public
        view
        returns (
            address organizer,
            address yearnVault,
            address token,
            uint256 dues,
            uint256 endTime,
            string memory leagueName,
            bool payoutsComplete
        )
    {
        Escrow storage escrow = escrows[_escrowId];
        return (
            escrow.organizer,
            address(escrow.yearnVault),
            address(escrow.token),
            escrow.dues,
            escrow.endTime,
            escrow.leagueName,
            escrow.payoutsComplete
        );
    }
} 