'use strict';

const { buildOrganizationAgent } = require('../personas');

async function loadOrganizationAgent(executor, customerId) {
    const { rows } = await executor.query(
        `SELECT config.display_name, config.prompt_instructions
           FROM organization_voice_config config
           JOIN customers customer ON customer.id = config.customer_id
          WHERE config.customer_id = $1
            AND config.enabled
            AND customer.is_active`,
        [customerId],
    );
    if (!rows[0]) {
        const error = new Error('Organization voice configuration is missing or disabled');
        error.code = 'organization_voice_not_configured';
        throw error;
    }
    return buildOrganizationAgent({
        organizationName: rows[0].display_name,
        promptInstructions: rows[0].prompt_instructions,
    });
}

module.exports = { loadOrganizationAgent };
