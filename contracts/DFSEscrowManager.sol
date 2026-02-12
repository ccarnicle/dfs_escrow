// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IVaultFactory} from "./interfaces/IVaultFactory.sol";
import {IYearnVault} from "./interfaces/IYearnVault.sol";

/**
 * @title DFSEscrowManager
 * @author aiSports
 * @notice This contract manages the creation, participation, and payout of PYUSD-based DFS contests on Flow EVM.
 * It integrates with Yearn V3 Vaults for secure fund custody, where each escrow gets its own dedicated vault.
 * The contract itself does not hold user funds for escrows; it acts as a role manager for the Yearn vaults.
 * @dev This is a DFS-specific variant that supports:
 * - PYUSD (6 decimals) instead of standard 18-decimal tokens
 * - Multi-entry support (up to maxEntriesPerUser entries per user)
 * - Higher participant/entry caps for DFS scale
 * - Shorter minimum escrow duration for daily contests
 * - Admin-settable maxEntriesPerUser configuration
 * The trust model assumes the organizer is responsible for triggering payouts correctly.
 * This contract is designed for standard ERC20 tokens and does not support fee-on-transfer or rebasing tokens.
 */
contract DFSEscrowManager is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // --- Constants ---
    uint256 public constant MAX_RECIPIENTS = 100; // Increased for DFS scale (from 30)
    uint256 public constant MINIMUM_DUES = 1 * 1e6; // PYUSD has 6 decimals (changed from 1e18)
    uint256 public constant MAX_LEAGUE_NAME_LENGTH = 50; // max length of the league name to prevent overflows
    uint256 public constant MINIMUM_ESCROW_DURATION = 1 hours; // Shorter duration for daily contests (changed from 1 days)
    uint256 public constant MAX_PARTICIPANTS_CAP = 100_000; // Increased for DFS scale (from 10_000)

    // --- State Variables ---
    address public immutable yearnVaultFactory;
    uint256 public nextEscrowId;
    
    // Multi-entry configuration
    uint256 public maxEntriesPerUser = 1000; // Admin-settable max entries per user per escrow

    // Authorized creators whitelist
    mapping(address => bool) public authorizedCreators;

    // User-centric tracking
    mapping(address => uint256[]) public createdEscrows;
    mapping(address => uint256[]) public joinedEscrows;
    uint256[] public activeEscrowIds;
    
    // Multi-entry tracking: escrowId => user => entry count
    mapping(uint256 => mapping(address => uint256)) public userEntryCount;

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
        uint256 totalEntries; // Total entries across all users for this escrow
    }

    mapping(uint256 => Escrow) public escrows;

    // Overflow recipient mapping: escrowId => recipient address
    // If unset (zero), defaults to escrow.organizer
    mapping(uint256 => address) public overflowRecipient;

    // --- Events ---
    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed organizer,
        address yearnVault,
        address indexed token,
        uint256 dues,
        uint256 endTime
    );

    event ParticipantJoined(uint256 indexed escrowId, address indexed participant, uint256 numEntries);

    event WinningsDistributed(
        uint256 indexed escrowId,
        address[] winners,
        uint256[] amounts,
        address overflowRecipient,
        uint256 overflowAmount
    );

    event OverflowRecipientSet(uint256 indexed escrowId, address indexed recipient);

    event PoolFunded(uint256 indexed escrowId, address indexed contributor, uint256 amount);
    
    event MaxEntriesPerUserUpdated(uint256 newMaxEntriesPerUser);
    
    event AuthorizedCreatorAdded(address indexed creator);
    event AuthorizedCreatorRemoved(address indexed creator);

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
    error InsufficientPool(uint256 totalPayout, uint256 maxWithdrawable);
    error InsufficientWithdrawn(uint256 withdrawn, uint256 required);
    error EmptyLeagueName();
    error WinnerNotParticipant();
    error InvalidMaxEntries();
    error ExceedsMaxEntriesPerUser();
    error ExceedsMaxParticipants();
    error NotAuthorizedCreator();

    // --- Constructor ---
    constructor(address _yearnVaultFactory) Ownable(msg.sender) {
        yearnVaultFactory = _yearnVaultFactory;
        // Auto-authorize the owner to create escrows
        authorizedCreators[msg.sender] = true;
        emit AuthorizedCreatorAdded(msg.sender);
        // Initialize nextEscrowId to 1 so escrow IDs start at 1
        nextEscrowId = 1;
    }

    // --- Modifiers ---
    
    /**
     * @notice Modifier to ensure only authorized creators can create escrows.
     */
    modifier onlyAuthorizedCreator() {
        if (!authorizedCreators[msg.sender]) revert NotAuthorizedCreator();
        _;
    }

    // --- External Functions ---

    /**
     * @notice Creates a new prize pool (escrow).
     * @dev Deploys a new Yearn V3 Vault to hold the funds for this escrow.
     * Note: For DFS, the organizer does NOT automatically join upon creation.
     * @param _token The ERC20 token for the prize pool (typically PYUSD).
     * @param _dues The amount required to join (in token's native decimals, e.g. 1e6 for PYUSD).
     * @param _endTime The timestamp when the escrow closes for new participants.
     * @param _vaultName The name for the new Yearn Vault.
     * @param _maxParticipants The maximum number of entries allowed (interpreted as max entries, not unique wallets).
     * @param _overflowRecipient Optional address to receive surplus funds. If zero, defaults to organizer.
     */
    function createEscrow(
        address _token,
        uint256 _dues,
        uint256 _endTime,
        string calldata _vaultName,
        uint256 _maxParticipants,
        address _overflowRecipient
    ) external nonReentrant onlyAuthorizedCreator {
        if (_token == address(0)) revert InvalidToken();
        if (_dues < MINIMUM_DUES) revert InvalidDues();
        if (bytes(_vaultName).length == 0) revert EmptyLeagueName();
        if (bytes(_vaultName).length > MAX_LEAGUE_NAME_LENGTH) revert LeagueNameTooLong();
        if (_endTime < block.timestamp + MINIMUM_ESCROW_DURATION) revert EndTimeTooSoon();
        if (_maxParticipants == 0 || _maxParticipants > MAX_PARTICIPANTS_CAP) revert InvalidMaxParticipants();

        uint256 escrowId = nextEscrowId;

        // Deploy a new Yearn vault for this escrow.
        // The DFSEscrowManager will be the role_manager, giving it control over the vault.
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

        // As the role_manager, the DFSEscrowManager gives itself the DEPOSIT_LIMIT_MANAGER role.
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
        newEscrow.totalEntries = 0; // Initialize total entries to 0

        // Track the created escrow
        createdEscrows[msg.sender].push(escrowId);
        newEscrow.activeArrayIndex = activeEscrowIds.length;
        activeEscrowIds.push(escrowId);

        nextEscrowId++;

        // Set overflow recipient if provided
        if (_overflowRecipient != address(0)) {
            overflowRecipient[escrowId] = _overflowRecipient;
            emit OverflowRecipientSet(escrowId, _overflowRecipient);
        }

        emit EscrowCreated(
            escrowId,
            msg.sender,
            newVaultAddress,
            _token,
            _dues,
            _endTime
        );

        // NOTE: For DFS, organizer does NOT automatically join upon creation.
        // Admin-created escrows start empty; users join by paying dues.
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
     * @notice Joins an existing prize pool with a specified number of entries.
     * @dev Transfers `dues * numEntries` from the caller into the escrow's Yearn Vault.
     * Supports multi-entry: users can join with multiple entries in a single transaction.
     * @param _escrowId The ID of the escrow to join.
     * @param _numEntries The number of entries to purchase (must be > 0).
     */
    function joinEscrow(uint256 _escrowId, uint256 _numEntries) external nonReentrant {
        if (_numEntries == 0) revert InvalidAmount();
        
        Escrow storage escrow = escrows[_escrowId];

        if (block.timestamp > escrow.endTime) revert EscrowEnded();
        
        // Check if adding these entries would exceed the user's max entries per escrow
        uint256 currentUserEntries = userEntryCount[_escrowId][msg.sender];
        if (currentUserEntries + _numEntries > maxEntriesPerUser) {
            revert ExceedsMaxEntriesPerUser();
        }
        
        // Check if adding these entries would exceed the escrow's max participants (interpreted as max entries)
        if (escrow.totalEntries + _numEntries > escrow.maxParticipants) {
            revert ExceedsMaxParticipants();
        }

        // Update entry counts
        userEntryCount[_escrowId][msg.sender] += _numEntries;
        escrow.totalEntries += _numEntries;
        
        // If this is the user's first entry in this escrow, mark them as a participant
        bool isFirstEntry = currentUserEntries == 0;
        if (isFirstEntry) {
            escrow.participants[msg.sender] = true;
            escrow.participantsList.push(msg.sender);
            joinedEscrows[msg.sender].push(_escrowId);
        }

        // Calculate total dues required
        uint256 totalDues = escrow.dues * _numEntries;

        // The user must have approved this contract to spend their tokens.
        // First, transfer the funds from the user to this DFSEscrowManager contract.
        escrow.token.safeTransferFrom(msg.sender, address(this), totalDues);
        
        // Then, approve the Yearn vault to pull the funds from this contract.
        escrow.token.forceApprove(address(escrow.yearnVault), 0);
        escrow.token.forceApprove(address(escrow.yearnVault), totalDues);

        // Finally, deposit the funds into the Yearn vault.
        // The DFSEscrowManager contract receives the shares, acting as custodian for the participants.
        escrow.yearnVault.deposit(totalDues, address(this));

        emit ParticipantJoined(_escrowId, msg.sender, _numEntries);
    }

    /**
     * @notice Sets the overflow recipient for an escrow.
     * @dev Can only be called by the organizer before payouts are complete.
     * @param _escrowId The ID of the escrow.
     * @param _recipient The address to receive surplus funds (cannot be zero address).
     */
    function setOverflowRecipient(uint256 _escrowId, address _recipient) external {
        Escrow storage escrow = escrows[_escrowId];
        
        if (msg.sender != escrow.organizer) revert NotOrganizer();
        if (_recipient == address(0)) revert InvalidToken();
        if (escrow.payoutsComplete) revert PayoutsAlreadyComplete();
        
        overflowRecipient[_escrowId] = _recipient;
        emit OverflowRecipientSet(_escrowId, _recipient);
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
        
        // Handle zero winners case: withdraw all funds and send to overflow recipient
        if (_winners.length == 0) {
            uint256 maxWithdrawable = escrow.yearnVault.maxWithdraw(address(this));
            
            // Determine overflow recipient (defaults to organizer if not set)
            address overflowTo = overflowRecipient[_escrowId];
            if (overflowTo == address(0)) {
                overflowTo = escrow.organizer;
            }
            
            // Mark payouts as complete
            escrow.payoutsComplete = true;
            
            // O(1) removal from the active list
            uint256 indexToRemove = escrow.activeArrayIndex;
            uint256 lastEscrowId = activeEscrowIds[activeEscrowIds.length - 1];
            activeEscrowIds[indexToRemove] = lastEscrowId;
            escrows[lastEscrowId].activeArrayIndex = indexToRemove;
            activeEscrowIds.pop();
            
            // Emit event with overflow info
            emit WinningsDistributed(_escrowId, _winners, _amounts, overflowTo, 0);
            
            // Withdraw all funds and send to overflow recipient
            if (maxWithdrawable > 0) {
                uint256 balanceBefore = escrow.token.balanceOf(address(this));
                escrow.yearnVault.withdraw(maxWithdrawable, address(this), address(this));
                uint256 withdrawnAmount = escrow.token.balanceOf(address(this)) - balanceBefore;
                
                if (withdrawnAmount > 0) {
                    escrow.token.safeTransfer(overflowTo, withdrawnAmount);
                }
            }
            
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

        // Require that total payout does not exceed max withdrawable
        if (totalPayout > maxWithdrawable) {
            revert InsufficientPool(totalPayout, maxWithdrawable);
        }

        // Determine overflow recipient (defaults to organizer if not set)
        address overflowTo = overflowRecipient[_escrowId];
        if (overflowTo == address(0)) {
            overflowTo = escrow.organizer;
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

        // --- INTERACTIONS ---
        uint256 overflowAmount = 0;
        if (maxWithdrawable > 0) {
            uint256 balanceBefore = escrow.token.balanceOf(address(this));
            escrow.yearnVault.withdraw(maxWithdrawable, address(this), address(this));
            uint256 withdrawnAmount = escrow.token.balanceOf(address(this)) - balanceBefore;

            // Ensure we withdrew at least the required amount
            if (withdrawnAmount < totalPayout) {
                revert InsufficientWithdrawn(withdrawnAmount, totalPayout);
            }

            // Distribute exact amounts to all winners
            for (uint256 i = 0; i < _winners.length; i++) {
                uint256 amount = _amounts[i];
                if (amount > 0) {
                    escrow.token.safeTransfer(_winners[i], amount);
                }
            }

            // Calculate and transfer overflow to recipient
            overflowAmount = withdrawnAmount - totalPayout;
        }

        // Emit the distribution event after interactions (includes overflow info)
        emit WinningsDistributed(_escrowId, _winners, _amounts, overflowTo, overflowAmount);

        // Transfer overflow amount if any
        if (overflowAmount > 0) {
            escrow.token.safeTransfer(overflowTo, overflowAmount);
        }
    }

    /**
     * @notice Sets the maximum number of entries allowed per user per escrow.
     * @dev Can only be called by the contract owner.
     * @param _newMaxEntriesPerUser The new maximum entries per user (must be > 0).
     */
    function setMaxEntriesPerUser(uint256 _newMaxEntriesPerUser) external onlyOwner {
        if (_newMaxEntriesPerUser == 0) revert InvalidMaxEntries();
        maxEntriesPerUser = _newMaxEntriesPerUser;
        emit MaxEntriesPerUserUpdated(_newMaxEntriesPerUser);
    }

    /**
     * @notice Adds an address to the authorized creators whitelist.
     * @dev Can only be called by the contract owner.
     * @param _creator The address to authorize for creating escrows.
     */
    function addAuthorizedCreator(address _creator) external onlyOwner {
        if (_creator == address(0)) revert InvalidToken();
        authorizedCreators[_creator] = true;
        emit AuthorizedCreatorAdded(_creator);
    }

    /**
     * @notice Removes an address from the authorized creators whitelist.
     * @dev Can only be called by the contract owner.
     * @param _creator The address to remove from authorized creators.
     */
    function removeAuthorizedCreator(address _creator) external onlyOwner {
        authorizedCreators[_creator] = false;
        emit AuthorizedCreatorRemoved(_creator);
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
    
    /**
     * @notice Returns the number of entries a user has in a specific escrow.
     * @param _escrowId The ID of the escrow.
     * @param _user The address of the user.
     * @return The number of entries the user has in the escrow.
     */
    function getUserEntryCount(uint256 _escrowId, address _user) external view returns (uint256) {
        return userEntryCount[_escrowId][_user];
    }
    
    /**
     * @notice Returns the total number of entries for a specific escrow.
     * @param _escrowId The ID of the escrow.
     * @return The total number of entries across all users for this escrow.
     */
    function getTotalEntries(uint256 _escrowId) external view returns (uint256) {
        return escrows[_escrowId].totalEntries;
    }
    
    /**
     * @notice Checks if an address is authorized to create escrows.
     * @param _address The address to check.
     * @return True if the address is authorized, false otherwise.
     */
    function isAuthorizedCreator(address _address) external view returns (bool) {
        return authorizedCreators[_address];
    }
}
