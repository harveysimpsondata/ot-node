import { createRequire } from 'module';
import Command from '../command.js';
import { SEND_TELEMETRY_COMMAND_FREQUENCY_MINUTES } from '../../constants/constants.js';

const require = createRequire(import.meta.url);
const pjson = require('../../../package.json');

class SendTelemetryCommand extends Command {
    constructor(ctx) {
        super(ctx);
        this.logger = ctx.logger;
        this.config = ctx.config;
        this.networkModuleManager = ctx.networkModuleManager;
        this.blockchainModuleManager = ctx.blockchainModuleManager;
        this.tripleStoreModuleManager = ctx.tripleStoreModuleManager;
        this.repositoryModuleManager = ctx.repositoryModuleManager;
        this.telemetryModuleManager = ctx.telemetryModuleManager;
    }

    /**
     * Performs code update by fetching new code from github repo
     * @param command
     */
    async execute() {
        if (
            !this.config.modules.telemetry.enabled ||
            !this.telemetryModuleManager.getModuleConfiguration().sendTelemetryData
        ) {
            return Command.empty();
        }

        try {
            const events = (await this.getUnpublishedEvents()) || [];
            const blockchainsNodeInfo = [];
            const blockchainImplementations = this.blockchainModuleManager.getImplementationNames();
            for (const implementation of blockchainImplementations) {
                const blockchainInfo = {
                    blockchain_id: implementation,
                    // eslint-disable-next-line no-await-in-loop
                    identity_id: await this.blockchainModuleManager.getIdentityId(implementation),
                    operational_wallet: this.blockchainModuleManager.getPublicKey(implementation),
                    management_wallet:
                        this.blockchainModuleManager.getManagementKey(implementation),
                };
                blockchainsNodeInfo.push(blockchainInfo);
            }
            const tripleStoreImplementations =
                this.tripleStoreModuleManager.getImplementationNames();
            const nodeData = {
                version: pjson.version,
                identity: this.networkModuleManager.getPeerId().toB58String(),
                hostname: this.config.hostname,
                triple_stores: tripleStoreImplementations,
                auto_update_enabled: this.config.modules.autoUpdater.enabled,
                multiaddresses: this.networkModuleManager.getMultiaddrs(),
                blockchains: blockchainsNodeInfo,
            };
            const isDataSuccessfullySent = await this.telemetryModuleManager.sendTelemetryData(
                nodeData,
                events,
            );
            if (isDataSuccessfullySent && events?.length > 0) {
                await this.removePublishedEvents(events);
            }
        } catch (error) {
            await this.handleError(error.message);
        }
        return Command.repeat();
    }

    async recover(command) {
        await this.handleError(command.message);

        return Command.repeat();
    }

    async handleError(errorMessage) {
        this.logger.error(`Error in send telemetry command: ${errorMessage}`);
    }

    /**
     * Builds default otnodeUpdateCommand
     * @param map
     * @returns {{add, data: *, delay: *, deadline: *}}
     */
    default(map) {
        const command = {
            name: 'sendTelemetryCommand',
            delay: 0,
            data: {},
            period: SEND_TELEMETRY_COMMAND_FREQUENCY_MINUTES * 60 * 1000,
            transactional: false,
        };
        Object.assign(command, map);
        return command;
    }

    async getUnpublishedEvents() {
        return this.repositoryModuleManager.getUnpublishedEvents();
    }

    async removePublishedEvents(events) {
        const ids = events.map((event) => event.id);

        await this.repositoryModuleManager.destroyEvents(ids);
    }
}

export default SendTelemetryCommand;
