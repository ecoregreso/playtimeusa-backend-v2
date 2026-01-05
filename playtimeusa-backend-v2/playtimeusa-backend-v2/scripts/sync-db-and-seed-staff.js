// scripts/sync-db-and-seed-staff.js
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { sequelize, StaffUser } = require('../src/models');

async function main() {
  console.log('=== Sync DB & Seed Staff ===');

  const qi = sequelize.getQueryInterface();

  // 🔥 DEV-ONLY: drop old vouchers table so schema can be recreated cleanly.
  // This will DELETE existing voucher rows. Perfectly fine for where you are now.
  try {
    console.log('-> Dropping old vouchers table if it exists (dev reset)...');
    await qi.dropTable('vouchers');
    console.log('   vouchers table dropped.');
  } catch (err) {
    console.log('   No existing vouchers table to drop or drop failed (safe to ignore).');
  }

  console.log('-> Syncing Sequelize models with DB...');
  await sequelize.sync({ alter: true });
  console.log('   Sync complete.');

  // OWNER
  const ownerUsername = process.env.OWNER_USERNAME || 'owner';
  const ownerPassword = process.env.OWNER_PASSWORD || 'ChangeMeNow!123';

  let owner = await StaffUser.findOne({ where: { username: ownerUsername } });

  if (!owner) {
    console.log(`-> Creating owner account: ${ownerUsername}`);
    const ownerHash = await bcrypt.hash(ownerPassword, 10);

    owner = await StaffUser.create({
      username: ownerUsername,
      passwordHash: ownerHash,
      role: 'owner',
      isActive: true,
    });

    console.log('   Owner created.');
    console.log('   LOGIN CREDENTIALS:');
    console.log(`     username: ${ownerUsername}`);
    console.log(`     password: ${ownerPassword}`);
  } else {
    console.log(`-> Owner account already exists: ${ownerUsername}`);
  }

  // OPERATOR (optional)
  const operatorUsername = process.env.OPERATOR_USERNAME || 'operator01';
  const operatorPassword = process.env.OPERATOR_PASSWORD || 'Operator123!';

  let operator = await StaffUser.findOne({ where: { username: operatorUsername } });
  if (!operator) {
    console.log(`-> Creating operator account: ${operatorUsername}`);
    const hash = await bcrypt.hash(operatorPassword, 10);
    operator = await StaffUser.create({
      username: operatorUsername,
      passwordHash: hash,
      role: 'operator',
      isActive: true,
      parentId: owner.id,
    });

    console.log('   Operator created.');
    console.log(`   username: ${operatorUsername}`);
    console.log(`   password: ${operatorPassword}`);
  } else {
    console.log(`-> Operator account already exists: ${operatorUsername}`);
  }

  // AGENT (optional)
  const agentUsername = process.env.AGENT_USERNAME || 'agent01';
  const agentPassword = process.env.AGENT_PASSWORD || 'Agent123!';
  const agentCode = process.env.AGENT_CODE || 'AG-001';

  let agent = await StaffUser.findOne({ where: { username: agentUsername } });
  if (!agent) {
    console.log(`-> Creating agent account: ${agentUsername}`);
    const hash = await bcrypt.hash(agentPassword, 10);
    agent = await StaffUser.create({
      username: agentUsername,
      passwordHash: hash,
      role: 'agent',
      agentCode,
      isActive: true,
      parentId: operator.id,
    });

    console.log('   Agent created.');
    console.log(`   username: ${agentUsername}`);
    console.log(`   password: ${agentPassword}`);
    console.log(`   agentCode: ${agentCode}`);
  } else {
    console.log(`-> Agent account already exists: ${agentUsername}`);
  }

  // CASHIER (optional)
  const cashierUsername = process.env.CASHIER_USERNAME || 'cashier01';
  const cashierPassword = process.env.CASHIER_PASSWORD || 'Cashier123!';

  let cashier = await StaffUser.findOne({ where: { username: cashierUsername } });
  if (!cashier) {
    console.log(`-> Creating cashier account: ${cashierUsername}`);
    const hash = await bcrypt.hash(cashierPassword, 10);
    cashier = await StaffUser.create({
      username: cashierUsername,
      passwordHash: hash,
      role: 'cashier',
      isActive: true,
      parentId: agent.id,
    });

    console.log('   Cashier created.');
    console.log(`   username: ${cashierUsername}`);
    console.log(`   password: ${cashierPassword}`);
  } else {
    console.log(`-> Cashier account already exists: ${cashierUsername}`);
  }

  console.log('=== Staff seeding complete. ===');
  await sequelize.close();
  console.log('DB connection closed.');
}

main().catch((err) => {
  console.error('FATAL ERROR in sync-db-and-seed-staff:', err);
  process.exit(1);
});
