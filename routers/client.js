const express = require("express");
const adminAuth = require("../middleware/adminAuth");
const bcrypt = require("bcryptjs");
const prisma = require("../prisma/prismaClient");
const { syncMaxDevicesToUserCount } = require("../helper/syncMaxDevices");

const router = express.Router();

router.get("/all", adminAuth, async (req, res) => {
  try {
    const take = parseInt(req.query.take || 10);
    const skip = parseInt(req.query.skip || 0);
    const q = req.query.q || "";

    const where = q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { username: { contains: q, mode: "insensitive" } },
            { labName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
          ],
        }
      : {};

    const total = await prisma.client.count({ where });

    const clients = await prisma.client.findMany({
      where,
      take,
      skip,
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        name: true,
        username: true,
        platform: true,
        phone: true,
        labName: true,
        email: true,
        address: true,
        active: true,
        device: true,
        Plan: true,
        balance: true,
        createdAt: true,
        syncEnabled: true,
        maxDevices: true,
      },
    });

    res.status(200).json({ data: clients, total });
  } catch (error) {
    console.error("Error fetching clients:", error);
    res.status(500).json({ error: "Could not fetch clients" });
  }
});

router.post("/", adminAuth, async (req, res) => {
  try {
    const {
      name,
      username,
      password,
      labName,
      phone,
      email,
      address,
      device,
      type,
    } = req.body;

    if (!name || !username || !password || !phone || !type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const plan = await prisma.plan.findUnique({
      where: { type: type },
    });
    if (!plan) {
      return res.status(400).json({ error: "Invalid plan type" });
    }

    const existingUsername = await prisma.client.findUnique({
      where: { username },
    });
    if (existingUsername) {
      return res.status(400).json({ error: "Username already exists" });
    }

    const existingPhone = await prisma.client.findUnique({
      where: { phone },
    });
    if (existingPhone) {
      return res.status(400).json({ error: "Phone number already exists" });
    }

    if (device) {
      const existingDevice = await prisma.client.findUnique({
        where: { device },
      });
      if (existingDevice) {
        return res.status(400).json({ error: "Device already registered" });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newClient = await prisma.client.create({
      data: {
        name,
        username,
        password: hashedPassword,
        labName,
        phone,
        email,
        address,
        device,
        planId: plan.id,
      },
    });

    res
      .status(200)
      .json({ success: true, message: "client created successfully" });
  } catch (error) {
    console.error("Error creating client:", error);
    if (error.code === "P2002") {
      return res.status(400).json({ error: "Unique constraint violation" });
    }
    res.status(500).json({ error: "Could not create client" });
  }
});

router.put("/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, labName, phone, email, address, device, type, active } =
      req.body;

    const existingClient = await prisma.client.findUnique({
      where: { id: parseInt(id) },
    });
    if (!existingClient) {
      return res.status(404).json({ error: "Client not found" });
    }

    let plan = null;

    if (type) {
      plan = await prisma.plan.findUnique({
        where: { type },
      });
      if (!plan) {
        return res.status(400).json({ error: "Invalid plan type" });
      }
    }

    if (phone && phone !== existingClient.phone) {
      const existingPhone = await prisma.client.findUnique({
        where: { phone },
      });
      if (existingPhone) {
        return res.status(400).json({ error: "Phone number already exists" });
      }
    }

    if (device && device !== existingClient.device) {
      const existingDevice = await prisma.client.findUnique({
        where: { device },
      });
      if (existingDevice) {
        return res.status(400).json({ error: "Device already registered" });
      }
    }

    const updatedClient = await prisma.client.update({
      where: { id: parseInt(id) },
      data: {
        name,
        labName,
        phone,
        email,
        address,
        device,
        planId: type ? plan.id : existingClient.planId,
        active,
      },
    });

    // console.log(updatedClient);

    res.status(200).json({ message: "Client updated!" });
  } catch (error) {
    console.error("Error updating client:", error);
    if (error.code === "P2002") {
      return res.status(400).json({ error: "Unique constraint violation" });
    }
    res.status(500).json({ error: "Could not update client" });
  }
});

router.put("/add-balance/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const amount = parseFloat(req.body.balance);

    if (!amount || isNaN(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ error: "Amount must be a positive number" });
    }

    const client = await prisma.client.findUnique({
      where: { id: parseInt(id) },
      include: {
        Plan: true,
      },
    });

    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }

    if (client.Plan.type === "FREE") {
      return res
        .status(400)
        .json({ error: "Free Plan clients cannot receive balance" });
    }

    const [updatedClient, newWallet] = await prisma.$transaction([
      prisma.client.update({
        where: { id: parseInt(id) },
        data: {
          balance: {
            increment: amount,
          },
        },
      }),
      prisma.wallet.create({
        data: {
          clientId: parseInt(id),
          amount: amount,
          type: "BALANCE",
          whatsappMsgPrice: client.whatsappMsgPrice ?? 0.05,
          createdAt: new Date(),
        },
      }),
    ]);

    res.status(200).json({
      message: "Balance added and wallet entry created",
      balance: updatedClient.balance,
    });
  } catch (error) {
    console.error("Error adding balance:", error);
    res.status(500).json({ error: "Could not update balance" });
  }
});

router.put("/reset-password/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: "Password is required" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.client.update({
      where: { id: parseInt(id) },
      data: { password: hashedPassword },
    });

    res.status(200).json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error updating password:", error);
    res.status(500).json({ error: "Could not update password" });
  }
});

router.put("/toggle-status/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const client = await prisma.client.findUnique({
      where: { id: parseInt(id) },
    });

    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }

    const updatedClient = await prisma.client.update({
      where: { id: parseInt(id) },
      data: {
        active: !client.active,
      },
    });

    res.status(200).json({ message: "client status updated successfully" });
  } catch (error) {
    console.error("Error toggling client status:", error);
    res.status(500).json({ error: "Could not toggle client status" });
  }
});

// Device slots always match the lab's operator headcount (see
// helper/syncMaxDevices.js) — this endpoint only flips sync on/off; it
// doesn't take a maxDevices input anymore.
router.put("/sync/:id", adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { syncEnabled } = req.body;

    const client = await prisma.client.findUnique({
      where: { id },
      include: { Plan: true },
    });
    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }

    if (syncEnabled && client.Plan?.type === "FREE") {
      return res.status(400).json({ error: "Multi-PC Sync requires a paid plan." });
    }

    if (syncEnabled !== undefined) {
      await prisma.client.update({
        where: { id },
        data: { syncEnabled: !!syncEnabled },
      });
    }
    await syncMaxDevicesToUserCount(id);

    const updatedClient = await prisma.client.findUnique({ where: { id } });

    res.status(200).json({
      message: "Sync settings updated",
      syncEnabled: updatedClient.syncEnabled,
      maxDevices: updatedClient.maxDevices,
    });
  } catch (error) {
    console.error("Error updating sync settings:", error);
    res.status(500).json({ error: "Could not update sync settings" });
  }
});

router.get("/devices/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const devices = await prisma.device.findMany({
      where: { clientId: parseInt(id) },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        machineId: true,
        name: true,
        platform: true,
        lastSeenAt: true,
        revokedAt: true,
        createdAt: true,
        userId: true,
        User: { select: { id: true, name: true, phone: true } },
      },
    });

    res.status(200).json({ devices });
  } catch (error) {
    console.error("Error listing devices:", error);
    res.status(500).json({ error: "Could not list devices" });
  }
});

router.post("/devices/:deviceId/revoke", adminAuth, async (req, res) => {
  try {
    const deviceId = parseInt(req.params.deviceId);

    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }

    await prisma.device.update({
      where: { id: deviceId },
      data: { revokedAt: new Date() },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error revoking device:", error);
    res.status(500).json({ error: "Could not revoke device" });
  }
});

router.post("/devices/:deviceId/unrevoke", adminAuth, async (req, res) => {
  try {
    const deviceId = parseInt(req.params.deviceId);

    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }
    if (!device.revokedAt) {
      return res.status(200).json({ success: true });
    }

    const client = await prisma.client.findUnique({ where: { id: device.clientId } });
    const activeCount = await prisma.device.count({
      where: { clientId: device.clientId, revokedAt: null },
    });
    if (activeCount >= client.maxDevices) {
      return res.status(409).json({
        error: `Device limit reached (${client.maxDevices}). Revoke another device first.`,
      });
    }

    await prisma.device.update({
      where: { id: deviceId },
      data: { revokedAt: null },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error unrevoking device:", error);
    res.status(500).json({ error: "Could not unrevoke device" });
  }
});

router.get("/users/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const users = await prisma.user.findMany({
      where: { clientId: parseInt(id) },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        role: true,
        phone: true,
        username: true,
        platform: true,
        isVerified: true,
        lastActive: true,
        createdAt: true,
        clientId: true,
        homeClientId: true,
        HomeClient: { select: { id: true, name: true, labName: true } },
      },
    });

    res.status(200).json({ users });
  } catch (error) {
    console.error("Error listing users:", error);
    res.status(500).json({ error: "Could not list users" });
  }
});

router.put("/users/:userId", adminAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { name, role, clientId } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!existingUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (clientId !== undefined) {
      const targetClient = await prisma.client.findUnique({
        where: { id: parseInt(clientId) },
      });
      if (!targetClient) {
        return res.status(400).json({ error: "Target lab not found" });
      }
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(clientId !== undefined ? { clientId: parseInt(clientId) } : {}),
      },
    });

    if (clientId !== undefined && parseInt(clientId) !== existingUser.clientId) {
      await Promise.all([
        syncMaxDevicesToUserCount(existingUser.clientId),
        syncMaxDevicesToUserCount(parseInt(clientId)),
      ]);
    }

    res.status(200).json({ message: "User updated" });
  } catch (error) {
    console.error("Error updating user:", error);
    res.status(500).json({ error: "Could not update user" });
  }
});

router.post("/users/:userId/revoke-device", adminAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await prisma.device.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Also clear the legacy User.device pin — this is what actually blocks
    // re-login ("already logged in from another device") on non-sync labs,
    // since that check reads User.device rather than the Device table.
    if (user.device) {
      await prisma.user.update({
        where: { id: userId },
        data: { device: null, platform: null },
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error revoking user devices:", error);
    res.status(500).json({ error: "Could not revoke user devices" });
  }
});

module.exports = router;
