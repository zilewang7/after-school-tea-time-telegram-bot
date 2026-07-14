import { Sequelize } from '@sequelize/core';

export const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: process.env.DB_PATH || 'database.sqlite',
});