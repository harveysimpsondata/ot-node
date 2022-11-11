import Command from '../../../command.js';

class EpochCheckCommand extends Command {
    constructor(ctx) {
        super(ctx);
        this.commandExecutor = ctx.commandExecutor;
        this.blockchainModuleManager = ctx.blockchainModuleManager;
    }

    async execute(command) {
        const { blockchain, agreementId, epoch } = command.data;

        let { serviceAgreement } = command.data;
        if (!serviceAgreement) {
            serviceAgreement = await this.blockchainModuleManager.getServiceAgreement(
                blockchain,
                agreementId,
            );
        }

        if (this.assetLifetimeExpired(serviceAgreement, epoch)) {
            return Command.empty();
        }
        const commitWindowOpen = await this.blockchainModuleManager.isCommitWindowOpen(
            blockchain,
            agreementId,
            epoch,
        );

        if (!commitWindowOpen) {
            await this.scheduleNextEpochCheck(blockchain, agreementId, epoch, serviceAgreement);
            return Command.empty();
        }

        const commits = await this.blockchainModuleManager.getCommitSubmissions(
            blockchain,
            agreementId,
            epoch,
        );

        const myIdentity = this.blockchainModuleManager.getIdentity(blockchain);

        // calculate proofs -> schedule proof submission -> schedule next epoch
        if (this.alreadyCommitted(commits, myIdentity)) {
            await this.commandExecutor.add({
                name: 'calculateProofsCommand',
                sequence: [],
                delay: 0,
                data: { ...command.data, serviceAgreement },
                transactional: false,
            });
            return Command.empty();
        }

        // submit commit -> calculate proofs -> schedule proof submission -> schedule next epoch
        const { prevId, rank } = this.previousIdentityId(commits);

        // todo get r1 from chain
        if (rank < 5) {
            await this.commandExecutor.add({
                name: 'submitCommitCommand',
                sequence: [],
                delay: 0,
                data: { ...command.data, prevId, serviceAgreement },
                transactional: false,
            });
        }
        return Command.empty();
    }

    previousIdentityId(commits) {
        const score = this.serviceAgreementService.calculateScore();

        [...commits].reverse().forEach((commit, index) => {
            if (commit.score > score) {
                return { prevId: commit.identityId, rank: commits.length - index - 1 };
            }
        });
        return { prevId: '', rank: 0 };
    }

    alreadyCommitted(commits, myIdentity) {
        commits.forEach((commit) => {
            if (commit.identityId === myIdentity) {
                return true;
            }
        });
        return false;
    }

    async scheduleNextEpochCheck(blockchain, agreementId, currentEpoch, serviceAgreement) {
        const nextEpochStartTime =
            serviceAgreement.startTime + serviceAgreement.epochLength * currentEpoch;
        await this.commandExecutor.add({
            name: 'epochCheckCommand',
            sequence: [],
            delay: nextEpochStartTime - Date.now(),
            data: {
                blockchain,
                agreementId,
                epoch: currentEpoch + 1,
                serviceAgreement,
            },
            transactional: false,
        });
    }

    assetLifetimeExpired(serviceAgreement, currentEpoch) {
        return serviceAgreement.epochsNum < currentEpoch;
    }

    /**
     * Builds default handleStoreInitCommand
     * @param map
     * @returns {{add, data: *, delay: *, deadline: *}}
     */
    default(map) {
        const command = {
            name: 'epochCheckCommand',
            delay: 0,
            transactional: false,
        };
        Object.assign(command, map);
        return command;
    }
}

export default EpochCheckCommand;
