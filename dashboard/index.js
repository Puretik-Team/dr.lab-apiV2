// Endpoints used by the admin dashboard only.
// Kept separate from ./routers so the existing client/app APIs stay untouched.
const express = require("express");

const labsRouter = require("./labs");
const usersRouter = require("./users");
const templatesRouter = require("./templates");

const router = express.Router();

router.use("/labs", labsRouter);
router.use("/users", usersRouter);
router.use("/templates", templatesRouter);

module.exports = router;
