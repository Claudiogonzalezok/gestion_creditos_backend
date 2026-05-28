require('dotenv').config();
const { execSync } = require('child_process');

const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME } = process.env;
const url = `postgresql://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public`;

execSync(`npx prisma studio --url="${url}"`, { stdio: 'inherit' });
