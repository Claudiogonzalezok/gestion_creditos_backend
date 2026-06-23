const router = require("express").Router();
const controller = require("./notifications.controller");
const v = require("../../utils/validators");
const { validate } = require("../../middlewares/validate.middleware");
const {
  authenticate,
  authorize,
} = require("../../middlewares/auth.middleware");

router.use(authenticate);

// ── Preferencias (config global V1) — solo ADMIN ───────────────
router.get("/preferences", authorize("ADMIN"), controller.getPreferences);

router.put(
  "/preferences/:type",
  authorize("ADMIN"),
  v.notifications.updatePreference,
  validate,
  controller.updatePreference,
);

// ── Historial / badge — cualquier usuario autenticado ──────────
router.get("/", controller.listByUser);

router.get("/unread-count", controller.unreadCount);

router.post("/:id/read", v.notifications.id, validate, controller.markRead);

router.post("/read-all", controller.markAllRead);

module.exports = router;
