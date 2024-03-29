export async function up({ context: { queryInterface, Sequelize } }) {
    await queryInterface.createTable('role_ability', {
        id: {
            allowNull: false,
            autoIncrement: true,
            primaryKey: true,
            type: Sequelize.INTEGER,
        },
        ability_id: {
            type: Sequelize.INTEGER,
            references: {
                model: 'ability',
                key: 'id',
            },
        },
        role_id: {
            type: Sequelize.INTEGER,
            references: {
                model: 'role',
                key: 'id',
            },
        },
        created_at: {
            allowNull: true,
            type: Sequelize.DATE,
            defaultValue: Sequelize.literal('NOW()'),
        },
        updated_at: {
            allowNull: true,
            type: Sequelize.DATE,
            defaultValue: Sequelize.literal('NOW()'),
        },
    });
}
export async function down({ context: { queryInterface } }) {
    await queryInterface.dropTable('role_ability');
}
