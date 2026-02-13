const { Op } = require("sequelize");
const { AuthLockout } = require("../models");

const FAIL_THRESHOLD = 5;
const BASE_LOCK_MINUTES = 5;
const MAX_LOCK_MINUTES = 60;

function computeLockDurationMinutes(failCount) {
  if (failCount < FAIL_THRESHOLD) return 0;
  const over = failCount - FAIL_THRESHOLD;
  const step = Math.floor(over / 2);
  const minutes = BASE_LOCK_MINUTES * Math.pow(2, step);
  return Math.min(MAX_LOCK_MINUTES, minutes);
}

async function getLock(subjectType, subjectId, tenantId = null) {
  const lock = await AuthLockout.findOne({
    where: { subjectType, subjectId, tenantId: tenantId || null },
  });
  if (!lock) return { locked: false, failCount: 0, lockUntil: null };
  const now = new Date();
  const locked = lock.lockUntil && new Date(lock.lockUntil) > now;
  return { locked, lockUntil: lock.lockUntil, failCount: lock.failCount, record: lock };
}

async function recordFailure({ subjectType, subjectId, tenantId = null, ip = null, userAgent = null }) {
  const now = new Date();
  const [lock] = await AuthLockout.findOrCreate({
    where: { subjectType, subjectId, tenantId: tenantId || null },
    defaults: { failCount: 0 },
  });

  lock.failCount += 1;
  const minutes = computeLockDurationMinutes(lock.failCount);
  if (minutes > 0) {
    lock.lockUntil = new Date(now.getTime() + minutes * 60 * 1000);
  }
  lock.lastIp = ip || lock.lastIp;
  lock.lastUserAgent = userAgent || lock.lastUserAgent;
  await lock.save();
  return { failCount: lock.failCount, lockUntil: lock.lockUntil };
}

async function recordSuccess({ subjectType, subjectId, tenantId = null }) {
  await AuthLockout.destroy({ where: { subjectType, subjectId, tenantId: tenantId || null } });
}

module.exports = {
  FAIL_THRESHOLD,
  computeLockDurationMinutes,
  getLock,
  recordFailure,
  recordSuccess,
};
