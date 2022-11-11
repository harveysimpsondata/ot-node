import ProtocolRequestCommand from '../../../common/protocol-request-command.js';
import { ERROR_TYPE } from '../../../../../constants/constants.js';

class PublishRequestCommand extends ProtocolRequestCommand {
    constructor(ctx) {
        super(ctx);
        this.operationService = ctx.publishService;

        this.errorType = ERROR_TYPE.PUBLISH.PUBLISH_STORE_REQUEST_ERROR;
    }

    async prepareMessage(command) {
        const { publishType, operationId, assertionId, blockchain, contract, tokenId, keyword } =
            command.data;
        const { assertion } = await this.operationIdService.getCachedOperationIdData(operationId);

        return {
            publishType,
            assertionId,
            blockchain,
            contract,
            assertion,
            tokenId,
            keyword,
        };
    }

    /**
     * Builds default publishRequestCommand
     * @param map
     * @returns {{add, data: *, delay: *, deadline: *}}
     */
    default(map) {
        const command = {
            name: 'v1_0_2PublishRequestCommand',
            delay: 0,
            transactional: false,
        };
        Object.assign(command, map);
        return command;
    }
}

export default PublishRequestCommand;
