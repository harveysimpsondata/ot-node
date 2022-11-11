import Web3 from 'web3';
import axios from 'axios';
import { createRequire } from 'module';
import { join } from 'path';
import appRootPath from 'app-root-path';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import {
    INIT_ASK_AMOUNT,
    INIT_STAKE_AMOUNT,
    BLOCKCHAIN_IDENTITY_DIRECTORY,
    WEBSOCKET_PROVIDER_OPTIONS,
    DEFAULT_BLOCKCHAIN_EVENT_SYNC_PERIOD_IN_MILLS,
    MAXIMUM_NUMBERS_OF_BLOCKS_TO_FETCH,
} from '../../../constants/constants.js';

const require = createRequire(import.meta.url);
const Hub = require('dkg-evm-module/build/contracts/Hub.json');
const AssertionRegistry = require('dkg-evm-module/build/contracts/AssertionRegistry.json');
const AssetRegistry = require('dkg-evm-module/build/contracts/AssetRegistry.json');
const ERC20Token = require('dkg-evm-module/build/contracts/ERC20Token.json');
const Identity = require('dkg-evm-module/build/contracts/Identity.json');
const Profile = require('dkg-evm-module/build/contracts/Profile.json');
const ProfileStorage = require('dkg-evm-module/build/contracts/ProfileStorage.json');
const ShardingTable = require('dkg-evm-module/build/contracts/ShardingTable.json');

class Web3Service {
    async initialize(config, logger) {
        this.config = config;
        this.logger = logger;

        this.rpcNumber = 0;
        await this.readIdentity();
        await this.initializeWeb3();
        this.currentBlock = await this.web3.eth.getBlockNumber();
        await this.initializeContracts();
    }

    async initializeWeb3() {
        let tries = 0;
        let isRpcConnected = false;
        while (!isRpcConnected) {
            if (tries >= this.config.rpcEndpoints.length) {
                throw Error('Blockchain initialisation failed');
            }

            try {
                if (this.config.rpcEndpoints[this.rpcNumber].startsWith('ws')) {
                    const provider = new Web3.providers.WebsocketProvider(
                        this.config.rpcEndpoints[this.rpcNumber],
                        WEBSOCKET_PROVIDER_OPTIONS,
                    );
                    this.web3 = new Web3(provider);
                } else {
                    this.web3 = new Web3(this.config.rpcEndpoints[this.rpcNumber]);
                }
                // eslint-disable-next-line no-await-in-loop
                isRpcConnected = await this.web3.eth.net.isListening();
            } catch (e) {
                this.logger.warn(
                    `Unable to connect to blockchain rpc : ${
                        this.config.rpcEndpoints[this.rpcNumber]
                    }.`,
                );
                tries += 1;
                this.rpcNumber = (this.rpcNumber + 1) % this.config.rpcEndpoints.length;
            }
        }
    }

    async initializeContracts() {
        // TODO encapsulate in a generic function
        this.logger.info(`Hub contract address is ${this.config.hubContractAddress}`);
        this.hubContract = new this.web3.eth.Contract(Hub.abi, this.config.hubContractAddress);

        const shardingTableAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['ShardingTable'],
        );
        this.ShardingTableContract = new this.web3.eth.Contract(
            ShardingTable.abi,
            shardingTableAddress,
        );

        const assertionRegistryAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['AssertionRegistry'],
        );
        this.AssertionRegistryContract = new this.web3.eth.Contract(
            AssertionRegistry.abi,
            assertionRegistryAddress,
        );

        const assetRegistryAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['AssetRegistry'],
        );
        this.AssetRegistryContract = new this.web3.eth.Contract(
            AssetRegistry.abi,
            assetRegistryAddress,
        );

        const tokenAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['Token'],
        );
        this.TokenContract = new this.web3.eth.Contract(ERC20Token.abi, tokenAddress);

        const profileAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['Profile'],
        );
        this.ProfileContract = new this.web3.eth.Contract(Profile.abi, profileAddress);

        const profileStorageAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['ProfileStorage'],
        );
        this.ProfileStorageContract = new this.web3.eth.Contract(
            ProfileStorage.abi,
            profileStorageAddress,
        );

        if (this.identityExists()) {
            this.identityContract = new this.web3.eth.Contract(Identity.abi, this.getIdentity());
        }

        this.logger.debug(
            `Connected to blockchain rpc : ${this.config.rpcEndpoints[this.rpcNumber]}.`,
        );

        await this.logBalances();
    }

    async readIdentity() {
        this.config.identity = await this.getIdentityFromFile();
    }

    getKeyPath() {
        let directoryPath;
        if (process.env.NODE_ENV === 'testnet' || process.env.NODE_ENV === 'mainnet') {
            directoryPath = join(
                appRootPath.path,
                '..',
                this.config.appDataPath,
                BLOCKCHAIN_IDENTITY_DIRECTORY,
            );
        } else {
            directoryPath = join(
                appRootPath.path,
                this.config.appDataPath,
                BLOCKCHAIN_IDENTITY_DIRECTORY,
            );
        }

        const fullPath = join(directoryPath, this.config.identityFileName);
        return { fullPath, directoryPath };
    }

    async getIdentityFromFile() {
        const keyPath = this.getKeyPath();
        if (await this.fileExists(keyPath.fullPath)) {
            const key = (await readFile(keyPath.fullPath)).toString();
            return key;
        }
    }

    async fileExists(filePath) {
        try {
            await stat(filePath);
            return true;
        } catch (e) {
            return false;
        }
    }

    async saveIdentityInFile() {
        if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
            const { fullPath, directoryPath } = this.getKeyPath();
            await mkdir(directoryPath, { recursive: true });
            await writeFile(fullPath, this.config.identity);
        }
    }

    async logBalances() {
        const nativeBalance = await this.getNativeTokenBalance();
        const tokenBalance = await this.getTokenBalance();
        this.logger.info(
            `Balance of ${this.getPublicKey()} is ${nativeBalance} ${
                this.baseTokenTicker
            } and ${tokenBalance} ${this.tracTicker}.`,
        );
    }

    async getNativeTokenBalance() {
        const nativeBalance = await this.web3.eth.getBalance(this.getPublicKey());
        return this.web3.utils.fromWei(nativeBalance);
    }

    async getTokenBalance() {
        const tokenBalance = await this.callContractFunction(this.TokenContract, 'balanceOf', [
            this.getPublicKey(),
        ]);
        return this.web3.utils.fromWei(tokenBalance);
    }

    identityExists() {
        return this.config.identity != null;
    }

    getIdentity() {
        return this.config.identity;
    }

    getBlockNumber() {
        return this.web3.eth.getBlockNumber();
    }

    // TODO get from blockchain
    getBlockTime() {
        return this.config.blockTime;
    }

    async deployIdentity() {
        if (!this.config.identity) {
            const transactionReceipt = await this.deployContract(Identity, [
                this.getPublicKey(),
                this.getManagementKey(),
            ]);
            this.config.identity = transactionReceipt.contractAddress;
        } else {
            this.logger.info(`Using existing identity: ${this.config.identity}`);
        }
    }

    async profileExists(identity) {
        const nodeId = await this.callContractFunction(this.ProfileStorageContract, 'getNodeId', [
            identity,
        ]);
        return nodeId != null;
    }

    async createProfile(peerId) {
        const stakeAmount = Web3.utils.toWei(INIT_STAKE_AMOUNT, 'ether');
        await this.executeContractFunction(this.TokenContract, 'increaseAllowance', [
            this.ProfileContract.options.address,
            stakeAmount,
        ]);

        await this.executeContractFunction(this.ProfileContract, 'createProfile', [
            this.getManagementKey(),
            this.convertAsciiToHex(peerId),
            INIT_ASK_AMOUNT,
            stakeAmount,
            this.getIdentity(),
        ]);
    }

    getEpochs(UAI) {
        return this.callContractFunction(this.AssetRegistryContract, 'getEpochs', [UAI]);
    }

    async getChallenge(UAI, epoch) {
        return this.callContractFunction(this.AssetRegistryContract, 'getChallenge', [
            UAI,
            epoch,
            this.getIdentity(),
        ]);
    }

    async answerChallenge(UAI, epoch, proof, leaf, price) {
        return this.executeContractFunction(this.AssetRegistryContract, 'answerChallenge', [
            UAI,
            epoch,
            proof,
            leaf,
            price,
            this.getIdentity(),
        ]);
    }

    async getReward(UAI, epoch) {
        return this.executeContractFunction(this.AssetRegistryContract, 'getReward', [
            UAI,
            epoch,
            this.getIdentity(),
        ]);
    }

    getPrivateKey() {
        return this.config.evmOperationalWalletPrivateKey;
    }

    getPublicKey() {
        return this.config.evmOperationalWalletPublicKey;
    }

    getManagementKey() {
        return this.config.evmManagementWalletPublicKey;
    }

    async getGasPrice() {
        try {
            const response = await axios.get(this.config.gasPriceOracleLink);
            const gasPriceRounded = Math.round(response.data.standard.maxFee * 1e9);
            return gasPriceRounded;
        } catch (error) {
            return undefined;
        }
    }

    async callContractFunction(contractInstance, functionName, args) {
        let result;
        while (result === undefined) {
            try {
                // eslint-disable-next-line no-await-in-loop
                result = await contractInstance.methods[functionName](...args).call();
            } catch (error) {
                // eslint-disable-next-line no-await-in-loop
                await this.handleError(error, functionName);
            }
        }

        return result;
    }

    async executeContractFunction(contractInstance, functionName, args) {
        let result;
        while (result === undefined) {
            try {
                /* eslint-disable no-await-in-loop */
                const gasPrice = await this.getGasPrice();

                const gasLimit = await contractInstance.methods[functionName](...args).estimateGas({
                    from: this.getPublicKey(),
                });

                const encodedABI = contractInstance.methods[functionName](...args).encodeABI();
                const tx = {
                    from: this.getPublicKey(),
                    to: contractInstance.options.address,
                    data: encodedABI,
                    gasPrice: gasPrice || this.web3.utils.toWei('20', 'Gwei'),
                    gas: gasLimit || this.web3.utils.toWei('900', 'Kwei'),
                };

                const createdTransaction = await this.web3.eth.accounts.signTransaction(
                    tx,
                    this.getPrivateKey(),
                );
                result = await this.web3.eth.sendSignedTransaction(
                    createdTransaction.rawTransaction,
                );
            } catch (error) {
                await this.handleError(error, functionName);
            }
        }

        return result;
    }

    async getAllPastEvents(
        contractName,
        onEventsReceived,
        getLastCheckedBlock,
        updateLastCheckedBlock,
    ) {
        const contract = this[contractName];
        if (!contract) {
            throw Error(`Error while getting all past events. Unknown contract: ${contractName}`);
        }

        const blockchainId = this.getBlockchainId();
        const lastCheckedBlockObject = await getLastCheckedBlock(blockchainId, contractName);

        let fromBlock;

        if (
            this.isOlderThan(
                lastCheckedBlockObject?.last_checked_timestamp,
                DEFAULT_BLOCKCHAIN_EVENT_SYNC_PERIOD_IN_MILLS,
            )
        ) {
            fromBlock = this.currentBlock - 10;
        } else {
            this.currentBlock = await this.getBlockNumber();
            fromBlock = lastCheckedBlockObject.last_checked_block + 1;
        }

        let events = [];
        if (this.currentBlock - fromBlock > MAXIMUM_NUMBERS_OF_BLOCKS_TO_FETCH) {
            let iteration = 1;

            while (fromBlock - MAXIMUM_NUMBERS_OF_BLOCKS_TO_FETCH > this.currentBlock) {
                events.concat(
                    await contract.getPastEvents('allEvents', {
                        fromBlock,
                        toBlock: fromBlock + MAXIMUM_NUMBERS_OF_BLOCKS_TO_FETCH * iteration,
                    }),
                );
                fromBlock += MAXIMUM_NUMBERS_OF_BLOCKS_TO_FETCH * iteration;
                iteration += 1;
            }
        } else {
            events = await contract.getPastEvents('allEvents', {
                fromBlock,
                toBlock: this.currentBlock,
            });
        }

        await updateLastCheckedBlock(blockchainId, this.currentBlock, Date.now(), contractName);
        if (events.length > 0) {
            await onEventsReceived(
                events.map((event) => ({
                    contract: contractName,
                    event: event.event,
                    data: JSON.stringify(event.returnValues),
                    block: event.blockNumber,
                    blockchainId,
                })),
            );
        }
    }

    isOlderThan(timestamp, olderThanInMills) {
        if (!timestamp) return true;
        const timestampThirtyDaysInPast = new Date().getTime() - olderThanInMills;
        return timestamp < timestampThirtyDaysInPast;
    }

    async deployContract(contract, args) {
        let result;
        while (!result) {
            try {
                const contractInstance = new this.web3.eth.Contract(contract.abi);
                const gasPrice = await this.getGasPrice();

                const gasLimit = await contractInstance
                    .deploy({
                        data: contract.bytecode,
                        arguments: args,
                    })
                    .estimateGas({
                        from: this.getPublicKey(),
                    });

                const encodedABI = contractInstance
                    .deploy({
                        data: contract.bytecode,
                        arguments: args,
                    })
                    .encodeABI();

                const tx = {
                    from: this.getPublicKey(),
                    data: encodedABI,
                    gasPrice: gasPrice ?? this.web3.utils.toWei('20', 'Gwei'),
                    gas: gasLimit ?? this.web3.utils.toWei('900', 'Kwei'),
                };

                const createdTransaction = await this.web3.eth.accounts.signTransaction(
                    tx,
                    this.getPrivateKey(),
                );

                return this.web3.eth.sendSignedTransaction(createdTransaction.rawTransaction);
            } catch (error) {
                await this.handleError(error, 'deploy');
            }
        }

        return result;
    }

    async getLatestCommitHash(contract, tokenId) {
        try {
            return await this.callContractFunction(this.AssetRegistryContract, 'getCommitHash', [
                tokenId,
                0,
            ]);
        } catch (e) {
            this.logger.error(`Error on calling contract function. ${e}`);
            return false;
        }
    }

    async getAssertionIssuer(assertionId) {
        return this.callContractFunction(this.AssertionRegistryContract, 'getIssuer', [
            assertionId,
        ]);
    }

    async getServiceAgreement(agreementId) {
        return this.callContractFunction(this.ServiceAgreementContract, 'serviceAgreements', [
            agreementId,
        ]);
    }

    async isCommitWindowOpen(agreementId, epoch) {
        return this.callContractFunction(this.ServiceAgreementContract, 'isCommitWindowOpen', [
            agreementId,
            epoch,
        ]);
    }

    async getCommitSubmissions(agreementId, epoch) {
        return this.callContractFunction(this.ServiceAgreementContract, 'getCommitSubmissions', [
            agreementId,
            epoch,
        ]);
    }

    async submitCommit(
        assetContractAddress,
        tokenId,
        keyword,
        hashingAlgorithm,
        epoch,
        prevIdentityId,
    ) {
        return this.callContractFunction(this.ServiceAgreementContract, 'submitCommit', [
            assetContractAddress,
            tokenId,
            keyword,
            hashingAlgorithm,
            epoch,
            prevIdentityId,
        ]);
    }

    async getShardingTableHead() {
        try {
            return await this.callContractFunction(this.ShardingTableContract, 'head', []);
        } catch (e) {
            this.logger.error(`Error on calling contract function. ${e}`);
            return false;
        }
    }

    async getShardingTableLength() {
        try {
            return await this.callContractFunction(this.ShardingTableContract, 'nodesCount', []);
        } catch (e) {
            this.logger.error(`Error on calling contract function. ${e}`);
            return false;
        }
    }

    async getShardingTablePage(startingPeerId, nodesNum) {
        try {
            return await this.callContractFunction(this.ShardingTableContract, 'getShardingTable', [
                startingPeerId,
                nodesNum,
            ]);
        } catch (e) {
            this.logger.error(`Error on calling contract function. ${e}`);
            return false;
        }
    }

    async getShardingTableFull() {
        try {
            return await this.callContractFunction(
                this.ShardingTableContract,
                'getShardingTable',
                [],
            );
        } catch (e) {
            this.logger.error(`Error on calling contract function. ${e}`);
            return false;
        }
    }

    async pushPeerBack(peerId, ask, stake) {
        try {
            return this.executeContractFunction(this.ShardingTableContract, 'pushBack', [
                peerId,
                ask,
                stake,
            ]);
        } catch (e) {
            this.logger.error(`Error on executing contract function. ${e}`);
            return false;
        }
    }

    async pushPeerFront(peerId, ask, stake) {
        try {
            return this.executeContractFunction(this.ShardingTableContract, 'pushFront', [
                peerId,
                ask,
                stake,
            ]);
        } catch (e) {
            this.logger.error(`Error on executing contract function. ${e}`);
            return false;
        }
    }

    async updatePeerParams(peerId, ask, stake) {
        try {
            return this.executeContractFunction(this.ShardingTableContract, 'updateParams', [
                peerId,
                ask,
                stake,
            ]);
        } catch (e) {
            this.logger.error(`Error on executing contract function. ${e}`);
            return false;
        }
    }

    async removePeer(peerId) {
        try {
            return this.executeContractFunction(this.ShardingTableContract, 'removePeer', [peerId]);
        } catch (e) {
            this.logger.error(`Error on executing contract function. ${e}`);
            return false;
        }
    }

    getBlockchainId() {
        throw Error('Get blockchain id not implemented');
    }

    convertAsciiToHex(peerId) {
        return Web3.utils.asciiToHex(peerId);
    }

    convertHexToAscii(peerIdHex) {
        return Web3.utils.hexToAscii(peerIdHex);
    }

    async healthCheck() {
        try {
            const gasPrice = await this.web3.eth.getGasPrice();
            if (gasPrice) return true;
        } catch (e) {
            this.logger.error(`Error on checking blockchain. ${e}`);
            return false;
        }
        return false;
    }

    async restartService() {
        this.rpcNumber = (this.rpcNumber + 1) % this.config.rpcEndpoints.length;
        this.logger.warn(
            `There was an issue with current blockchain rpc. Connecting to ${
                this.config.rpcEndpoints[this.rpcNumber]
            }`,
        );
        await this.initializeWeb3();
        await this.initializeContracts();
    }

    async handleError(error, functionName) {
        let isRpcError = false;
        try {
            await this.web3.eth.net.isListening();
        } catch (rpcError) {
            isRpcError = true;
            this.logger.warn(
                `Unable to execute smart contract function ${functionName} using blockchain rpc : ${
                    this.config.rpcEndpoints[this.rpcNumber]
                }.`,
            );
            await this.restartService();
        }
        if (!isRpcError) throw error;
    }
}

export default Web3Service;
