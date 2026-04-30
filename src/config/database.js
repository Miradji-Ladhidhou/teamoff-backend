require('dotenv').config();
const { Sequelize } = require('sequelize');

const isProduction = process.env.NODE_ENV === 'production';

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
  dialectOptions: isProduction
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : {},
  pool: {
    min: 2,
    max: isProduction ? 10 : 5,
    acquire: 30000,
    idle: 10000,
  },
});

module.exports = sequelize;
