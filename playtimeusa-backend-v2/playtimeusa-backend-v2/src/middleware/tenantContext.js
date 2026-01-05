const { sequelize, clsNamespace } = require("../db");

const SET_KEYS = new Set([
  "app.tenant_id",
  "app.role",
  "app.user_id",
  "app.distributor_id",
]);

function buildContext(ctx = {}) {
  return {
    tenantId: ctx.tenantId || null,
    role: ctx.role || null,
    userId: ctx.userId || null,
    distributorId: ctx.distributorId || null,
    allowMissingTenant: !!ctx.allowMissingTenant,
    force: !!ctx.force,
  };
}

async function setLocal(transaction, key, value) {
  if (!SET_KEYS.has(key)) {
    throw new Error(`Unsupported SET LOCAL key: ${key}`);
  }
  if (value == null || value === "") {
    await sequelize.query(`RESET ${key}`, { transaction });
    return;
  }
  await sequelize.query(`SET LOCAL ${key} = :value`, {
    transaction,
    replacements: { value: String(value) },
  });
}

async function applyContext(transaction, context) {
  await setLocal(transaction, "app.role", context.role || "unknown");
  await setLocal(transaction, "app.user_id", context.userId || "unknown");
  await setLocal(transaction, "app.distributor_id", context.distributorId || null);
  await setLocal(transaction, "app.tenant_id", context.tenantId || null);
}

function attachLifecycle(req, res, transaction) {
  if (req._tenantContextAttached) return;
  req._tenantContextAttached = true;

  let finished = false;
  const finalize = async (err) => {
    if (finished) return;
    finished = true;
    res.off("finish", onFinish);
    res.off("close", onClose);

    if (transaction.finished) return;
    try {
      if (err || res.statusCode >= 400) {
        await transaction.rollback();
      } else {
        await transaction.commit();
      }
    } catch (txErr) {
      console.error("[TENANT_CTX] finalize error:", txErr.message || txErr);
    }
  };

  const onFinish = () => finalize();
  const onClose = () => finalize(new Error("response closed"));

  res.on("finish", onFinish);
  res.on("close", onClose);
}

async function initTenantContext(req, res, ctx = {}, handler) {
  const context = buildContext(ctx);
  if (!context.tenantId && context.role !== "owner" && !context.allowMissingTenant) {
    const err = new Error("Tenant context required");
    err.status = 403;
    throw err;
  }

  if (req.transaction) {
    if (context.force) {
      await applyContext(req.transaction, context);
    }
    if (handler) {
      return handler();
    }
    return;
  }

  return new Promise((resolve, reject) => {
    clsNamespace.run(() => {
      Promise.resolve()
        .then(async () => {
          const transaction = await sequelize.transaction();
          clsNamespace.set("transaction", transaction);
          req.transaction = transaction;
          req.tenantContext = {
            tenantId: context.tenantId,
            role: context.role,
            userId: context.userId,
            distributorId: context.distributorId,
          };

          try {
            await applyContext(transaction, context);
          } catch (err) {
            await transaction.rollback();
            throw err;
          }

          attachLifecycle(req, res, transaction);

          if (handler) {
            return handler();
          }
        })
        .then(resolve)
        .catch(reject);
    });
  });
}

module.exports = {
  initTenantContext,
};
